package capproxy

import (
	"context"
	"net"
	"strings"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/emptypb"
)

type testResolver struct {
	binding SandboxBinding
}

func (r testResolver) ResolveCapabilitySandbox(_ context.Context, token string) (SandboxBinding, error) {
	if token != "sandbox-token" {
		return SandboxBinding{}, status.Error(codes.Unauthenticated, "bad token")
	}
	return r.binding, nil
}

func staticOctoBus(addr, token string) OctoBusResolver {
	return func(context.Context) (string, string, bool) {
		return addr, token, true
	}
}

func TestProxyInjectsOctoBusMetadata(t *testing.T) {
	var received metadata.MD
	octoAddr, stopOcto := startTestRawGRPC(t, func(_ any, stream grpc.ServerStream) error {
		received, _ = metadata.FromIncomingContext(stream.Context())
		req := rawFrame(nil)
		if err := stream.RecvMsg(&req); err != nil {
			return err
		}
		return stream.SendMsg(rawFrame("ok:" + string(req)))
	})
	defer stopOcto()
	proxyAddr, stopProxy := startTestProxy(t, Config{Listen: "127.0.0.1:0", OctoBus: staticOctoBus(octoAddr, "octo-token")}, testResolver{binding: SandboxBinding{SandboxID: "s1", CapsetIDs: []string{"dev"}}})
	defer stopProxy()

	conn, err := grpc.NewClient(proxyAddr, grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithDefaultCallOptions(grpc.ForceCodec(rawCodec{})))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	ctx := metadata.NewOutgoingContext(context.Background(), metadata.Pairs(
		SandboxTokenMetadata, "sandbox-token",
		"x-octobus-instance", "inst",
	))
	out := rawFrame(nil)
	if err := conn.Invoke(ctx, "/pkg.Service/Call", rawFrame("ping"), &out); err != nil {
		t.Fatal(err)
	}
	if string(out) != "ok:ping" {
		t.Fatalf("unexpected response %q", string(out))
	}
	for key, want := range map[string]string{
		"x-octobus-capset":   "dev",
		"x-octobus-instance": "inst",
		"authorization":      "Bearer octo-token",
	} {
		if got := firstMetadata(received, key); got != want {
			t.Fatalf("metadata %s = %q, want %q", key, got, want)
		}
	}
}

func TestProxyForwardsGuestInstance(t *testing.T) {
	var received metadata.MD
	octoAddr, stopOcto := startTestRawGRPC(t, func(_ any, stream grpc.ServerStream) error {
		received, _ = metadata.FromIncomingContext(stream.Context())
		req := rawFrame(nil)
		if err := stream.RecvMsg(&req); err != nil {
			return err
		}
		return stream.SendMsg(rawFrame("ok:" + string(req)))
	})
	defer stopOcto()
	proxyAddr, stopProxy := startTestProxy(t, Config{Listen: "127.0.0.1:0", OctoBus: staticOctoBus(octoAddr, "")}, testResolver{binding: SandboxBinding{SandboxID: "s1", CapsetIDs: []string{"dev"}}})
	defer stopProxy()

	conn, err := grpc.NewClient(proxyAddr, grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithDefaultCallOptions(grpc.ForceCodec(rawCodec{})))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	ctx := metadata.NewOutgoingContext(context.Background(), metadata.MD{
		SandboxTokenMetadata: []string{"sandbox-token"},
		"x-octobus-instance": []string{"guest-inst"},
		"x-octobus-capset":   []string{"dev"},
	})
	out := rawFrame(nil)
	if err := conn.Invoke(ctx, "/pkg.Service/Call", rawFrame("ping"), &out); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]string{
		"x-octobus-capset":   "dev",
		"x-octobus-instance": "guest-inst",
	} {
		if got := firstMetadata(received, key); got != want {
			t.Fatalf("metadata %s = %q, want %q", key, got, want)
		}
	}
}

func TestProxyRejectsMissingInstanceForBusinessCall(t *testing.T) {
	octoAddr, stopOcto := startTestRawGRPC(t, func(_ any, stream grpc.ServerStream) error { return nil })
	defer stopOcto()
	proxyAddr, stopProxy := startTestProxy(t, Config{Listen: "127.0.0.1:0", OctoBus: staticOctoBus(octoAddr, "")}, testResolver{binding: SandboxBinding{SandboxID: "s1", CapsetIDs: []string{"dev"}}})
	defer stopProxy()

	conn, err := grpc.NewClient(proxyAddr, grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithDefaultCallOptions(grpc.ForceCodec(rawCodec{})))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	ctx := metadata.NewOutgoingContext(context.Background(), metadata.Pairs(SandboxTokenMetadata, "sandbox-token"))
	out := rawFrame(nil)
	err = conn.Invoke(ctx, "/pkg.Service/Call", rawFrame("ping"), &out)
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition for missing instance, got %v", err)
	}
}

func TestProxyRejectsCapsetOutsideAllowedSet(t *testing.T) {
	octoAddr, stopOcto := startTestRawGRPC(t, func(_ any, stream grpc.ServerStream) error { return nil })
	defer stopOcto()
	proxyAddr, stopProxy := startTestProxy(t, Config{Listen: "127.0.0.1:0", OctoBus: staticOctoBus(octoAddr, "")}, testResolver{binding: SandboxBinding{SandboxID: "s1", CapsetIDs: []string{"dev"}}})
	defer stopProxy()

	conn, err := grpc.NewClient(proxyAddr, grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithDefaultCallOptions(grpc.ForceCodec(rawCodec{})))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	// Guest requests a capset the sandbox is not allowed to use.
	ctx := metadata.NewOutgoingContext(context.Background(), metadata.MD{
		SandboxTokenMetadata: []string{"sandbox-token"},
		"x-octobus-capset":   []string{"other"},
	})
	out := rawFrame(nil)
	err = conn.Invoke(ctx, "/pkg.Service/Call", rawFrame("ping"), &out)
	if status.Code(err) != codes.PermissionDenied {
		t.Fatalf("expected PermissionDenied for disallowed capset, got %v", err)
	}
}

func TestProxyRejectsMissingSandboxToken(t *testing.T) {
	octoAddr, stopOcto := startTestRawGRPC(t, func(_ any, stream grpc.ServerStream) error { return nil })
	defer stopOcto()
	proxyAddr, stopProxy := startTestProxy(t, Config{Listen: "127.0.0.1:0", OctoBus: staticOctoBus(octoAddr, "")}, testResolver{binding: SandboxBinding{SandboxID: "s1", CapsetIDs: []string{"dev"}}})
	defer stopProxy()

	conn, err := grpc.NewClient(proxyAddr, grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithDefaultCallOptions(grpc.ForceCodec(rawCodec{})))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	out := rawFrame(nil)
	err = conn.Invoke(context.Background(), "/pkg.Service/Call", rawFrame("ping"), &out)
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("code = %s, want %s; err=%v", status.Code(err), codes.Unauthenticated, err)
	}
}

func TestServerConfiguredAndServeBranches(t *testing.T) {
	var nilServer *Server
	if nilServer.Configured() {
		t.Fatal("nil server should not be configured")
	}
	if NewServer(Config{Listen: "  ", OctoBus: staticOctoBus("127.0.0.1:1", "")}, testResolver{}).Configured() {
		t.Fatal("blank listen address should not be configured")
	}
	if NewServer(Config{Listen: "127.0.0.1:0", OctoBus: nil}, testResolver{}).Configured() {
		t.Fatal("nil OctoBus resolver should not be configured")
	}
	if NewServer(Config{Listen: "127.0.0.1:0", OctoBus: staticOctoBus("127.0.0.1:1", "")}, nil).Configured() {
		t.Fatal("nil sandbox resolver should not be configured")
	}
	if err := NewServer(Config{}, nil).Serve(context.Background()); err != nil {
		t.Fatalf("unconfigured Serve returned error: %v", err)
	}

	server := NewServer(Config{Listen: "127.0.0.1:bad", OctoBus: staticOctoBus("127.0.0.1:1", "")}, testResolver{})
	if !server.Configured() {
		t.Fatal("expected complete server to be configured")
	}
	if err := server.Serve(context.Background()); err == nil {
		t.Fatal("expected invalid listen address error")
	}
}

func TestResolveSandboxBearerFallbackAndErrors(t *testing.T) {
	server := NewServer(Config{}, testResolver{binding: SandboxBinding{SandboxID: "s1", CapsetIDs: []string{"dev"}}})
	ctx := metadata.NewIncomingContext(context.Background(), metadata.Pairs("authorization", "Bearer sandbox-token"))
	binding, err := server.resolveSandbox(ctx)
	if err != nil {
		t.Fatalf("resolveSandbox returned error: %v", err)
	}
	if binding.SandboxID != "s1" {
		t.Fatalf("binding SandboxID = %q, want s1", binding.SandboxID)
	}

	ctx = metadata.NewIncomingContext(context.Background(), metadata.Pairs(deprecatedSessionTokenMetadata, "sandbox-token"))
	if _, err := server.resolveSandbox(ctx); err != nil {
		t.Fatalf("deprecated token header fallback returned error: %v", err)
	}

	ctx = metadata.NewIncomingContext(context.Background(), metadata.Pairs("authorization", "Bearer bad-token"))
	if _, err := server.resolveSandbox(ctx); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("bad token code = %s, want %s; err=%v", status.Code(err), codes.Unauthenticated, err)
	}

	server = NewServer(Config{}, testResolver{binding: SandboxBinding{SandboxID: "s1"}})
	ctx = metadata.NewIncomingContext(context.Background(), metadata.Pairs(SandboxTokenMetadata, "sandbox-token"))
	if _, err := server.resolveSandbox(ctx); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("empty capset code = %s, want %s; err=%v", status.Code(err), codes.FailedPrecondition, err)
	}
}

func TestCapsetResolutionAndOutgoingMetadataHelpers(t *testing.T) {
	ctx := metadata.NewIncomingContext(context.Background(), metadata.MD{
		SandboxTokenMetadata: []string{"sandbox-token"},
		"authorization":      []string{"Bearer guest-token"},
		"x-octobus-capset":   []string{"old"},
		"x-custom":           []string{"kept"},
	})
	capset, err := resolveCallCapset(ctx, []string{"old", "other"})
	if err != nil {
		t.Fatalf("resolveCallCapset returned error: %v", err)
	}
	if capset != "old" {
		t.Fatalf("capset = %q, want old", capset)
	}

	ctx = metadata.NewIncomingContext(context.Background(), metadata.MD{})
	if _, err := resolveCallCapset(ctx, []string{"one", "two"}); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("ambiguous capset code = %s, want %s; err=%v", status.Code(err), codes.FailedPrecondition, err)
	}

	outgoing := buildOutgoingMetadata(metadata.NewIncomingContext(context.Background(), metadata.MD{
		SandboxTokenMetadata:           []string{"sandbox-token"},
		deprecatedSessionTokenMetadata: []string{"sandbox-token"},
		"authorization":                []string{"Bearer guest-token"},
		"x-octobus-capset":             []string{"old"},
		"x-custom":                     []string{"kept"},
	}), "new")
	if got := firstMetadata(outgoing, SandboxTokenMetadata); got != "" {
		t.Fatalf("sandbox token metadata was forwarded: %q", got)
	}
	if got := firstMetadata(outgoing, deprecatedSessionTokenMetadata); got != "" {
		t.Fatalf("deprecated token metadata was forwarded: %q", got)
	}
	if got := firstMetadata(outgoing, "authorization"); got != "" {
		t.Fatalf("authorization metadata was forwarded: %q", got)
	}
	if got := firstMetadata(outgoing, "x-octobus-capset"); got != "new" {
		t.Fatalf("capset metadata = %q, want new", got)
	}
	if got := firstMetadata(outgoing, "x-custom"); got != "kept" {
		t.Fatalf("custom metadata = %q, want kept", got)
	}
}

func TestProxyHelpersAndRawCodecBranches(t *testing.T) {
	if got := bearerToken("bearer  token "); got != "token" {
		t.Fatalf("bearer token = %q, want token", got)
	}
	if got := bearerToken("Basic token"); got != "" {
		t.Fatalf("non-bearer token = %q, want empty", got)
	}
	if got := normalizeGRPCTarget(" http://127.0.0.1:1234/ "); got != "127.0.0.1:1234" {
		t.Fatalf("normalized URL target = %q", got)
	}
	if got := normalizeGRPCTarget(" octobus:9000/ "); got != "octobus:9000" {
		t.Fatalf("normalized bare target = %q", got)
	}
	if got := normalizeGRPCTarget(" / "); got != "" {
		t.Fatalf("normalized empty target = %q", got)
	}
	if !isReflectionMethod("/grpc.reflection.v1.ServerReflection/ServerReflectionInfo") {
		t.Fatal("v1 reflection method was not detected")
	}
	if !isReflectionMethod("/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo") {
		t.Fatal("v1alpha reflection method was not detected")
	}
	if isReflectionMethod("/pkg.Service/Call") {
		t.Fatal("business method detected as reflection")
	}

	codec := rawCodec{}
	data, err := codec.Marshal(rawFrame("raw"))
	if err != nil {
		t.Fatalf("raw marshal failed: %v", err)
	}
	if string(data) != "raw" {
		t.Fatalf("raw marshal = %q, want raw", string(data))
	}
	frame := rawFrame("ptr")
	data, err = codec.Marshal(&frame)
	if err != nil {
		t.Fatalf("raw pointer marshal failed: %v", err)
	}
	if string(data) != "ptr" {
		t.Fatalf("raw pointer marshal = %q, want ptr", string(data))
	}
	if _, err := codec.Marshal(123); err == nil {
		t.Fatal("expected unsupported marshal type error")
	}

	var out rawFrame
	if err := codec.Unmarshal([]byte("decoded"), &out); err != nil {
		t.Fatalf("raw unmarshal failed: %v", err)
	}
	if string(out) != "decoded" {
		t.Fatalf("raw unmarshal = %q, want decoded", string(out))
	}
	if _, err := codec.Marshal(&emptypb.Empty{}); err != nil {
		t.Fatalf("proto marshal failed: %v", err)
	}
	if err := codec.Unmarshal(nil, &emptypb.Empty{}); err != nil {
		t.Fatalf("proto unmarshal failed: %v", err)
	}
	if err := codec.Unmarshal(nil, new(int)); err == nil {
		t.Fatal("expected unsupported unmarshal type error")
	}
}

func startTestProxy(t *testing.T, config Config, resolver SandboxResolver) (string, func()) {
	t.Helper()
	ln, err := net.Listen("tcp", config.Listen)
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	config.Listen = addr
	server := NewServer(config, resolver)
	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() { errCh <- server.serve(ctx, ln) }()
	return addr, func() {
		cancel()
		if err := <-errCh; err != nil && !strings.Contains(err.Error(), "use of closed network connection") {
			t.Fatalf("proxy returned error: %v", err)
		}
	}
}

func startTestRawGRPC(t *testing.T, handler grpc.StreamHandler) (string, func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer(grpc.ForceServerCodec(rawCodec{}), grpc.UnknownServiceHandler(func(srv any, stream grpc.ServerStream) error {
		return handler(srv, stream)
	}))
	errCh := make(chan error, 1)
	go func() { errCh <- server.Serve(ln) }()
	return ln.Addr().String(), func() {
		server.Stop()
		if err := <-errCh; err != nil && !strings.Contains(err.Error(), "use of closed network connection") {
			t.Fatalf("raw grpc returned error: %v", err)
		}
	}
}
