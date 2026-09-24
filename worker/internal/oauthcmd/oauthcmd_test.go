package oauthcmd

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/credential"
)

func TestUsageSuccessForwardsUserAgentAndBeta(t *testing.T) {
	var gotUA, gotBeta string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		gotUA = request.Header.Get("User-Agent")
		gotBeta = request.Header.Get("Anthropic-Beta")
		if request.Header.Get("Authorization") != "Bearer access-live" {
			t.Fatalf("authorization = %q", request.Header.Get("Authorization"))
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"daily":{"remaining":10}}`))
	}))
	defer server.Close()

	configPath, _ := testConfig(t, server.URL, server.URL+"/oauth/token", map[string]string{"UsEr-AgEnT": "custom-cli"})
	credPath := filepath.Join(filepath.Dir(configPath), "credentials.json")
	saveCredential(t, credPath, credential.Credential{AccessToken: "access-live", ExpiresAt: time.Now().Add(time.Hour).UnixMilli()})

	var output bytes.Buffer
	exitCode := Run([]string{"usage", "--config", configPath}, strings.NewReader(""), &output)
	if exitCode != 0 {
		t.Fatalf("exit code = %d, output = %s", exitCode, output.String())
	}
	var envelope responseEnvelope
	decodeOutput(t, &output, &envelope)
	if !envelope.OK || envelope.Status != http.StatusOK {
		t.Fatalf("envelope = %+v", envelope)
	}
	if gotUA != "custom-cli" || gotBeta != "oauth-2025-04-20" {
		t.Fatalf("headers: user-agent=%q anthropic-beta=%q", gotUA, gotBeta)
	}
}

func TestExpiredCredentialRefreshesBeforeProfileAndPersists(t *testing.T) {
	var refreshCalls, profileCalls int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/oauth/token":
			refreshCalls++
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{"access_token":"access-new","refresh_token":"refresh-new","expires_in":28800}`))
		case "/api/oauth/profile":
			profileCalls++
			if request.Header.Get("Authorization") != "Bearer access-new" {
				t.Fatalf("authorization = %q", request.Header.Get("Authorization"))
			}
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{"email":"user@example.com"}`))
		default:
			t.Fatalf("unexpected path %s", request.URL.Path)
		}
	}))
	defer server.Close()

	configPath, _ := testConfig(t, server.URL, server.URL+"/oauth/token", nil)
	credPath := filepath.Join(filepath.Dir(configPath), "credentials.json")
	saveCredential(t, credPath, credential.Credential{
		AccessToken:  "access-old",
		RefreshToken: "refresh-old",
		ExpiresAt:    time.Now().Add(-time.Minute).UnixMilli(),
	})

	var output bytes.Buffer
	if code := Run([]string{"profile", "--config", configPath}, nil, &output); code != 0 {
		t.Fatalf("exit code = %d, output = %s", code, output.String())
	}
	var envelope responseEnvelope
	decodeOutput(t, &output, &envelope)
	if !envelope.OK {
		t.Fatalf("envelope = %+v", envelope)
	}
	if refreshCalls != 1 || profileCalls != 1 {
		t.Fatalf("refresh calls=%d profile calls=%d", refreshCalls, profileCalls)
	}
	current, err := credential.NewStore(credPath).Status()
	if err != nil {
		t.Fatal(err)
	}
	if current.AccessToken != "access-new" || current.RefreshToken != "refresh-new" {
		t.Fatalf("credential = %+v", current)
	}
}

func TestRefreshOutputNeverContainsTokens(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"access_token":"secret-access","refresh_token":"secret-refresh","expires_in":3600}`))
	}))
	defer server.Close()

	configPath, _ := testConfig(t, server.URL, server.URL, nil)
	credPath := filepath.Join(filepath.Dir(configPath), "credentials.json")
	saveCredential(t, credPath, credential.Credential{
		AccessToken:  "old-access",
		RefreshToken: "old-refresh",
		ExpiresAt:    time.Now().Add(-time.Minute).UnixMilli(),
	})

	var output bytes.Buffer
	if code := Run([]string{"refresh", "--config", configPath}, nil, &output); code != 0 {
		t.Fatalf("exit code = %d, output = %s", code, output.String())
	}
	if strings.Contains(output.String(), "secret-access") || strings.Contains(output.String(), "secret-refresh") {
		t.Fatalf("refresh output leaked token: %s", output.String())
	}
	var envelope responseEnvelope
	decodeOutput(t, &output, &envelope)
	if !envelope.OK || envelope.Status != http.StatusOK {
		t.Fatalf("envelope = %+v", envelope)
	}
}

func TestCountTokensReadsStdin(t *testing.T) {
	var gotBody map[string]any
	var gotBeta string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/messages/count_tokens" {
			t.Fatalf("path = %s", request.URL.Path)
		}
		if err := json.NewDecoder(request.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		gotBeta = request.Header.Get("Anthropic-Beta")
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"input_tokens":12}`))
	}))
	defer server.Close()

	configPath, _ := testConfig(t, server.URL, server.URL, nil)
	credPath := filepath.Join(filepath.Dir(configPath), "credentials.json")
	saveCredential(t, credPath, credential.Credential{AccessToken: "access-live", ExpiresAt: time.Now().Add(time.Hour).UnixMilli()})

	input := `{"body":{"model":"claude-test","messages":[]},"headers":{"anthropic-beta":"beta-from-node"}}`
	var output bytes.Buffer
	if code := Run([]string{"count-tokens", "--config", configPath}, strings.NewReader(input), &output); code != 0 {
		t.Fatalf("exit code = %d, output = %s", code, output.String())
	}
	var envelope responseEnvelope
	decodeOutput(t, &output, &envelope)
	if !envelope.OK || gotBody["model"] != "claude-test" || gotBeta != "beta-from-node" {
		t.Fatalf("envelope=%+v body=%v beta=%q", envelope, gotBody, gotBeta)
	}
}

func TestUnknownOperationReturnsTwo(t *testing.T) {
	var output bytes.Buffer
	if code := Run([]string{"unknown", "--config", "/tmp/unused"}, nil, &output); code != 2 {
		t.Fatalf("exit code = %d, output = %s", code, output.String())
	}
	var envelope responseEnvelope
	decodeOutput(t, &output, &envelope)
	if envelope.OK || envelope.Body == nil {
		t.Fatalf("envelope = %+v", envelope)
	}
}

func TestUpstream401ReturnsFailedEnvelope(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusUnauthorized)
		_, _ = writer.Write([]byte(`{"error":{"type":"authentication_error","message":"unauthorized"}}`))
	}))
	defer server.Close()

	configPath, _ := testConfig(t, server.URL, server.URL, nil)
	credPath := filepath.Join(filepath.Dir(configPath), "credentials.json")
	saveCredential(t, credPath, credential.Credential{AccessToken: "access-live", ExpiresAt: time.Now().Add(time.Hour).UnixMilli()})

	var output bytes.Buffer
	if code := Run([]string{"usage", "--config", configPath}, nil, &output); code != 0 {
		t.Fatalf("exit code = %d, output = %s", code, output.String())
	}
	var envelope responseEnvelope
	decodeOutput(t, &output, &envelope)
	if envelope.OK || envelope.Status != http.StatusUnauthorized {
		t.Fatalf("envelope = %+v", envelope)
	}
}

func TestMissingCredentialReturnsCredentialRequired(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		t.Fatal("upstream should not be called without credentials")
	}))
	defer server.Close()

	configPath, _ := testConfig(t, server.URL, server.URL, nil)
	var output bytes.Buffer
	if code := Run([]string{"usage", "--config", configPath}, nil, &output); code != 0 {
		t.Fatalf("exit code = %d, output = %s", code, output.String())
	}
	var envelope responseEnvelope
	decodeOutput(t, &output, &envelope)
	if envelope.OK || envelope.Status != 0 {
		t.Fatalf("envelope = %+v", envelope)
	}
	body, ok := envelope.Body.(map[string]any)
	if !ok {
		t.Fatalf("body = %#v", envelope.Body)
	}
	errorBody, ok := body["error"].(map[string]any)
	if !ok || errorBody["code"] != "credential_required" {
		t.Fatalf("error body = %#v", body["error"])
	}
}

func testConfig(t *testing.T, anthropicURL, tokenURL string, headers map[string]string) (string, string) {
	t.Helper()
	dir := t.TempDir()
	configPath := filepath.Join(dir, "worker.json")
	credentialPath := filepath.Join(dir, "credentials.json")
	raw := map[string]any{
		"vm_id":              "vm-test",
		"socket_path":        filepath.Join(dir, "worker.sock"),
		"credential_path":    credentialPath,
		"proxy_required":     true,
		"egress_mode":        "transparent",
		"test_endpoints":     true,
		"anthropic_base_url": anthropicURL,
		"oauth_token_url":    tokenURL,
		"telemetry":          map[string]any{"headers": headers},
	}
	data, err := json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return configPath, credentialPath
}

func saveCredential(t *testing.T, path string, value credential.Credential) {
	t.Helper()
	if _, err := credential.NewStore(path).Save(value, nil); err != nil {
		t.Fatal(err)
	}
}

func decodeOutput(t *testing.T, output *bytes.Buffer, envelope *responseEnvelope) {
	t.Helper()
	if err := json.Unmarshal(output.Bytes(), envelope); err != nil {
		t.Fatalf("decode output: %v; output=%s", err, output.String())
	}
}
