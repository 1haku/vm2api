package egress

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

func TestForwardTCPThroughSOCKS(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		c, accErr := echo.Accept()
		if accErr != nil {
			return
		}
		defer c.Close()
		buf := make([]byte, 4)
		_, _ = io.ReadFull(c, buf)
		_, _ = c.Write(buf)
	}()

	socksLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer socksLn.Close()
	go serveTestSOCKS(t, socksLn)

	proxyURL := (&url.URL{Scheme: "socks5h", Host: socksLn.Addr().String()}).String()
	srv, err := New(Config{ProxyURL: proxyURL, ListenTCP: "127.0.0.1:0"})
	if err != nil {
		t.Fatal(err)
	}
	client, peer := net.Pipe()
	defer client.Close()
	go func() {
		_ = srv.ForwardTCP(context.Background(), peer, echo.Addr().String())
	}()
	if _, err = client.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, 4)
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err = io.ReadFull(client, got); err != nil {
		t.Fatal(err)
	}
	if string(got) != "ping" {
		t.Fatalf("got %q", got)
	}
}

func TestSpliceIdleClosesBoth(t *testing.T) {
	a, b := net.Pipe()
	c, d := net.Pipe()
	defer a.Close()
	defer c.Close()
	done := make(chan error, 1)
	go func() { done <- spliceIdle(b, d, "example:443", 40*time.Millisecond) }()
	select {
	case err := <-done:
		var se *spliceError
		if !errors.As(err, &se) || se.class != classIdleClose {
			t.Fatalf("got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("spliceIdle did not return")
	}
	if _, err := a.Write([]byte("x")); err == nil {
		t.Fatal("guest still writable after idle-close")
	}
}

func TestSpliceIdleResetsOnTraffic(t *testing.T) {
	a, b := net.Pipe()
	up, echo := net.Pipe()
	defer a.Close()
	go func() {
		buf := make([]byte, 8)
		for {
			n, err := echo.Read(buf)
			if err != nil {
				return
			}
			if _, err = echo.Write(buf[:n]); err != nil {
				return
			}
		}
	}()
	done := make(chan error, 1)
	go func() { done <- spliceIdle(b, up, "example:443", 120*time.Millisecond) }()
	for i := range 3 {
		time.Sleep(50 * time.Millisecond)
		if _, err := a.Write([]byte("ping")); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
		got := make([]byte, 4)
		_ = a.SetReadDeadline(time.Now().Add(time.Second))
		if _, err := io.ReadFull(a, got); err != nil {
			t.Fatalf("read %d: %v", i, err)
		}
		if string(got) != "ping" {
			t.Fatalf("got %q", got)
		}
	}
	_ = a.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("traffic should not idle-close: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("splice did not exit after close")
	}
}

func TestResolveDNSOverSOCKSTCP(t *testing.T) {
	dnsLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer dnsLn.Close()
	go func() {
		c, accErr := dnsLn.Accept()
		if accErr != nil {
			return
		}
		defer c.Close()
		var hdr [2]byte
		if _, err := io.ReadFull(c, hdr[:]); err != nil {
			return
		}
		n := int(binary.BigEndian.Uint16(hdr[:]))
		q := make([]byte, n)
		if _, err := io.ReadFull(c, q); err != nil {
			return
		}
		reply := append([]byte{}, q...)
		if len(reply) > 2 {
			reply[2] |= 0x80
		}
		out := make([]byte, 2+len(reply))
		binary.BigEndian.PutUint16(out[:2], uint16(len(reply)))
		copy(out[2:], reply)
		_, _ = c.Write(out)
	}()

	socksLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer socksLn.Close()
	go serveTestSOCKS(t, socksLn)

	proxyURL := (&url.URL{Scheme: "socks5h", Host: socksLn.Addr().String()}).String()
	srv, err := New(Config{
		ProxyURL:    proxyURL,
		ListenTCP:   "127.0.0.1:0",
		DNSUpstream: dnsLn.Addr().String(),
	})
	if err != nil {
		t.Fatal(err)
	}
	query := []byte{0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}
	reply, err := srv.ResolveDNS(context.Background(), query)
	if err != nil {
		t.Fatal(err)
	}
	if len(reply) < 3 || reply[0] != 0x12 || reply[2]&0x80 == 0 {
		t.Fatalf("reply=%v", reply)
	}
}

func TestResolveDNSOverDoH(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q, _ := io.ReadAll(r.Body)
		reply := append([]byte{}, q...)
		if len(reply) > 2 {
			reply[2] |= 0x80
		}
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(reply)
	}))
	defer ts.Close()

	socksLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer socksLn.Close()
	go serveTestSOCKS(t, socksLn)

	proxyURL := (&url.URL{Scheme: "socks5h", Host: socksLn.Addr().String()}).String()
	srv, err := New(Config{
		ProxyURL:    proxyURL,
		ListenTCP:   "127.0.0.1:0",
		DNSUpstream: ts.URL + "/dns-query",
	})
	if err != nil {
		t.Fatal(err)
	}
	query := []byte{0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}
	reply, err := srv.ResolveDNS(context.Background(), query)
	if err != nil {
		t.Fatal(err)
	}
	if len(reply) < 3 || reply[0] != 0x12 || reply[2]&0x80 == 0 {
		t.Fatalf("reply=%v", reply)
	}
}

func TestResolveDNSFallsBackToNextUpstream(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q, _ := io.ReadAll(r.Body)
		reply := append([]byte{}, q...)
		if len(reply) > 2 {
			reply[2] |= 0x80
		}
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(reply)
	}))
	defer ts.Close()
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "blocked", http.StatusBadGateway)
	}))
	defer dead.Close()

	socksLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer socksLn.Close()
	for i := 0; i < 3; i++ {
		go serveTestSOCKS(t, socksLn)
	}

	proxyURL := (&url.URL{Scheme: "socks5h", Host: socksLn.Addr().String()}).String()
	srv, err := New(Config{
		ProxyURL:    proxyURL,
		ListenTCP:   "127.0.0.1:0",
		DNSUpstream: dead.URL + "/dns-query, " + ts.URL + "/dns-query",
	})
	if err != nil {
		t.Fatal(err)
	}
	query := []byte{0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}
	reply, err := srv.ResolveDNS(context.Background(), query)
	if err != nil {
		t.Fatal(err)
	}
	if len(reply) < 3 || reply[0] != 0x12 || reply[2]&0x80 == 0 {
		t.Fatalf("reply=%v", reply)
	}
	if got := srv.preferred.Load(); got != 1 {
		t.Fatalf("preferred=%d want 1", got)
	}
}

func TestDefaultDNSUpstreamsWhenEmpty(t *testing.T) {
	srv, err := New(Config{ProxyURL: "socks5h://127.0.0.1:1", ListenTCP: "127.0.0.1:0"})
	if err != nil {
		t.Fatal(err)
	}
	if len(srv.upstreams) != len(DefaultDNSUpstreams) || srv.upstreams[0] != DefaultDNSUpstreams[0] {
		t.Fatalf("upstreams=%v", srv.upstreams)
	}
}

func serveTestSOCKS(t *testing.T, ln net.Listener) {
	t.Helper()
	c, err := ln.Accept()
	if err != nil {
		return
	}
	defer c.Close()
	head := make([]byte, 2)
	if _, err = io.ReadFull(c, head); err != nil {
		return
	}
	nmethod := int(head[1])
	if nmethod > 0 {
		_, _ = io.ReadFull(c, make([]byte, nmethod))
	}
	_, _ = c.Write([]byte{0x05, 0x00})
	req := make([]byte, 4)
	if _, err = io.ReadFull(c, req); err != nil {
		return
	}
	var host string
	var port uint16
	switch req[3] {
	case 0x01:
		addr := make([]byte, 4)
		_, _ = io.ReadFull(c, addr)
		host = net.IP(addr).String()
	case 0x03:
		l := make([]byte, 1)
		_, _ = io.ReadFull(c, l)
		name := make([]byte, l[0])
		_, _ = io.ReadFull(c, name)
		host = string(name)
	default:
		return
	}
	pb := make([]byte, 2)
	_, _ = io.ReadFull(c, pb)
	port = binary.BigEndian.Uint16(pb)
	up, err := net.Dial("tcp", net.JoinHostPort(host, formatPort(port)))
	if err != nil {
		_, _ = c.Write([]byte{0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return
	}
	defer up.Close()
	_, _ = c.Write([]byte{0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0})
	go func() { _, _ = io.Copy(up, c) }()
	_, _ = io.Copy(c, up)
}

func formatPort(port uint16) string {
	var digits [5]byte
	index := len(digits)
	value := int(port)
	for {
		index--
		digits[index] = byte('0' + value%10)
		value /= 10
		if value == 0 {
			break
		}
	}
	return string(digits[index:])
}
