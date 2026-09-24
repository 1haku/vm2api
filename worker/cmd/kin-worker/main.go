package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/config"
	"github.com/dofastted/kin-gateway/worker/internal/credential"
	"github.com/dofastted/kin-gateway/worker/internal/oauthcmd"
	"github.com/dofastted/kin-gateway/worker/internal/telemetry"
	"github.com/dofastted/kin-gateway/worker/internal/upstream"
)

func main() {
	if len(os.Args) < 2 {
		log.Printf("usage: kin-worker telemetry|oauth")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "telemetry":
		os.Exit(runTelemetry(os.Args[2:]))
	case "oauth":
		os.Exit(oauthcmd.Run(os.Args[2:], os.Stdin, os.Stdout))
	default:
		log.Printf("unknown kin-worker command %q", os.Args[1])
		os.Exit(2)
	}
}

func runTelemetry(args []string) int {
	fs := flag.NewFlagSet("telemetry", flag.ContinueOnError)
	configPath := fs.String("config", "", "path to worker JSON config")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Printf("telemetry: load config failed")
		return 1
	}
	// Disabled still enters Run. The loop re-reads worker.json, so a later
	// enable or identity rewrite is picked up without another docker exec.
	var httpClient *http.Client
	if cfg.EgressMode == "transparent" {
		httpClient, err = upstream.NewTransparentHTTPClient(20 * time.Second)
	} else {
		httpClient, err = upstream.NewHTTPClient(cfg.ProxyURL, cfg.ProxyRequired, 20*time.Second)
	}
	if err != nil {
		log.Printf("telemetry: http client failed")
		return 1
	}
	baseURL, err := url.Parse(cfg.AnthropicBaseURL)
	if err != nil {
		log.Printf("telemetry: base url failed")
		return 1
	}
	rootCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err = telemetry.Run(rootCtx, cfg, telemetry.Deps{
		HTTP: &telemetry.Client{
			HTTP:          httpClient,
			AnthropicBase: baseURL,
			Timeout:       15 * time.Second,
		},
		Store: credential.NewStore(cfg.CredentialPath),
	}); err != nil {
		log.Printf("telemetry: run failed")
		return 1
	}
	return 0
}
