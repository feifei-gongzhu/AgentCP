package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

type composeEnvContractFile struct {
	Services map[string]composeEnvContractService `yaml:"services"`
}

type composeEnvContractService struct {
	Image       string            `yaml:"image"`
	Environment map[string]string `yaml:"environment"`
	Volumes     []string          `yaml:"volumes"`
	WorkingDir  string            `yaml:"working_dir"`
	Privileged  *bool             `yaml:"privileged"`
	Devices     []string          `yaml:"devices"`
	Ports       []string          `yaml:"ports"`
}

func TestE2EDockerComposeSandboxEnvContract(t *testing.T) {
	root := repoRootForComposeEnvTest(t)
	composeData := readRepoFileForComposeEnvTest(t, root, "docker-compose.yml")
	envExample := string(readRepoFileForComposeEnvTest(t, root, ".env.example"))
	dockerfile := string(readRepoFileForComposeEnvTest(t, root, "Dockerfile"))

	var composeFile composeEnvContractFile
	if err := yaml.Unmarshal(composeData, &composeFile); err != nil {
		t.Fatalf("parse docker-compose.yml: %v", err)
	}
	service, ok := composeFile.Services["agent-compose"]
	if !ok {
		t.Fatalf("docker-compose.yml missing agent-compose service")
	}
	if !strings.Contains(service.Image, "AGENT_COMPOSE_IMAGE") || !strings.Contains(service.Image, "ghcr.io/chaitin/agent-compose:latest") {
		t.Fatalf("agent-compose image should stay deployable from published image, got %q", service.Image)
	}
	if hostRoot, ok := service.Environment["DOCKER_HOST_SANDBOX_ROOT"]; ok {
		t.Fatalf("compose must leave DOCKER_HOST_SANDBOX_ROOT unset for mount auto-detection, got %q", hostRoot)
	}
	for key := range service.Environment {
		if strings.Contains(key, "SESSION_ROOT") {
			t.Fatalf("compose service still exposes legacy session root env %q", key)
		}
	}
	for _, volume := range []string{"/var/run/docker.sock:/var/run/docker.sock", "${AGENT_COMPOSE_DATA_DIR:-./data}:/data", "./.env:/data/work/.env:ro"} {
		if !stringSliceContains(service.Volumes, volume) {
			t.Fatalf("agent-compose volumes = %#v, want %q", service.Volumes, volume)
		}
	}
	if service.WorkingDir != "/data/work" {
		t.Fatalf("agent-compose working_dir = %q, want /data/work", service.WorkingDir)
	}

	for _, want := range []string{
		"AGENT_COMPOSE_DATA_DIR=./data",
		"# SANDBOX_ROOT=/data/sandboxes",
		"# DOCKER_HOST_SANDBOX_ROOT=/absolute/host/path/to/data/sandboxes",
		"SESSION_ROOT, DOCKER_HOST_SESSION_ROOT, SESSION_START_TIMEOUT, and",
	} {
		if !strings.Contains(envExample, want) {
			t.Fatalf(".env.example missing %q", want)
		}
	}
	legacyAssignment := regexp.MustCompile(`(?m)^\s*(SESSION_ROOT|DOCKER_HOST_SESSION_ROOT|SESSION_START_TIMEOUT|SESSION_STOP_TIMEOUT)=`)
	if legacyAssignment.MatchString(envExample) {
		t.Fatalf(".env.example must not provide copyable legacy session env defaults")
	}
	for _, legacy := range []string{"SESSION_ROOT", "DOCKER_HOST_SESSION_ROOT"} {
		if strings.Contains(string(composeData), legacy) {
			t.Fatalf("docker-compose.yml contains legacy env %s", legacy)
		}
	}
	if strings.Contains(dockerfile, "ENV SANDBOX_ROOT=") {
		t.Fatalf("Dockerfile must leave SANDBOX_ROOT unset for legacy root detection")
	}
	if strings.Contains(dockerfile, "ENV SESSION_ROOT=") {
		t.Fatalf("Dockerfile still defines legacy SESSION_ROOT")
	}
}

func TestDockerComposeKVMOverlayContract(t *testing.T) {
	root := repoRootForComposeEnvTest(t)
	baseData := readRepoFileForComposeEnvTest(t, root, "docker-compose.yml")
	overlayData := readRepoFileForComposeEnvTest(t, root, "docker-compose.kvm.yml")
	localOverride := string(readRepoFileForComposeEnvTest(t, root, "docker-compose.override.yml.example"))
	dockerfile := string(readRepoFileForComposeEnvTest(t, root, "Dockerfile"))

	var base composeEnvContractFile
	if err := yaml.Unmarshal(baseData, &base); err != nil {
		t.Fatalf("parse docker-compose.yml: %v", err)
	}
	baseService, ok := base.Services["agent-compose"]
	if !ok {
		t.Fatal("docker-compose.yml missing agent-compose service")
	}
	if baseService.Privileged != nil {
		t.Fatalf("base agent-compose privileged = %v, want omitted", *baseService.Privileged)
	}
	if len(baseService.Devices) != 0 {
		t.Fatalf("base agent-compose devices = %#v, want none", baseService.Devices)
	}
	baseServiceKeys := composeContractServiceKeys(t, baseData, "docker-compose.yml")
	for _, forbidden := range []string{"build", "privileged", "devices"} {
		if _, ok := baseServiceKeys[forbidden]; ok {
			t.Fatalf("base agent-compose must omit %q", forbidden)
		}
	}
	if strings.Contains(string(baseData), "/dev/kvm") {
		t.Fatal("base Compose must not require /dev/kvm")
	}
	if _, ok := baseService.Environment["RUNTIME_DRIVER"]; ok {
		t.Fatal("base Compose must preserve the image-level RUNTIME_DRIVER default")
	}
	if !strings.Contains(dockerfile, "ENV RUNTIME_DRIVER=docker") {
		t.Fatal("Dockerfile must keep Docker as the image-level runtime default")
	}
	if !stringSliceContains(baseService.Ports, "127.0.0.1:7410:7410") {
		t.Fatalf("base agent-compose ports = %#v, want loopback daemon port", baseService.Ports)
	}

	var overlay composeEnvContractFile
	if err := yaml.Unmarshal(overlayData, &overlay); err != nil {
		t.Fatalf("parse docker-compose.kvm.yml: %v", err)
	}
	overlayService, ok := overlay.Services["agent-compose"]
	if !ok {
		t.Fatal("docker-compose.kvm.yml missing agent-compose service")
	}
	if overlayService.Privileged == nil || !*overlayService.Privileged {
		t.Fatalf("KVM overlay privileged = %v, want true", overlayService.Privileged)
	}
	if len(overlayService.Devices) != 1 || overlayService.Devices[0] != "/dev/kvm:/dev/kvm" {
		t.Fatalf("KVM overlay devices = %#v, want only /dev/kvm", overlayService.Devices)
	}
	if !strings.Contains(localOverride, "build:") {
		t.Fatal("local Compose override example must retain build behavior")
	}
	for _, forbidden := range []string{"privileged:", "devices:", "/dev/kvm", "COMPOSE_FILE"} {
		if strings.Contains(localOverride, forbidden) {
			t.Fatalf("local Compose override example contains deployment-only KVM setting %q", forbidden)
		}
	}
	assertComposeKVMOverlayKeys(t, overlayData)
}

func assertComposeKVMOverlayKeys(t *testing.T, data []byte) {
	t.Helper()
	var document map[string]any
	if err := yaml.Unmarshal(data, &document); err != nil {
		t.Fatalf("parse docker-compose.kvm.yml structure: %v", err)
	}
	if len(document) != 1 {
		t.Fatalf("KVM overlay top-level keys = %#v, want only services", document)
	}
	services, ok := document["services"].(map[string]any)
	if !ok || len(services) != 1 {
		t.Fatalf("KVM overlay services = %#v, want only agent-compose", document["services"])
	}
	service := composeContractServiceKeys(t, data, "docker-compose.kvm.yml")
	if len(service) != 2 {
		t.Fatalf("KVM overlay agent-compose keys = %#v, want only privileged and devices", services["agent-compose"])
	}
	for _, key := range []string{"privileged", "devices"} {
		if _, ok := service[key]; !ok {
			t.Fatalf("KVM overlay agent-compose missing %q", key)
		}
	}
}

func composeContractServiceKeys(t *testing.T, data []byte, name string) map[string]any {
	t.Helper()
	var document map[string]any
	if err := yaml.Unmarshal(data, &document); err != nil {
		t.Fatalf("parse %s structure: %v", name, err)
	}
	services, ok := document["services"].(map[string]any)
	if !ok {
		t.Fatalf("%s services = %#v, want mapping", name, document["services"])
	}
	service, ok := services["agent-compose"].(map[string]any)
	if !ok {
		t.Fatalf("%s agent-compose = %#v, want mapping", name, services["agent-compose"])
	}
	return service
}

func repoRootForComposeEnvTest(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(wd, "go.mod")); err == nil {
			return wd
		}
		parent := filepath.Dir(wd)
		if parent == wd {
			t.Fatalf("could not locate repo root from test working directory")
		}
		wd = parent
	}
}

func readRepoFileForComposeEnvTest(t *testing.T, root, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return data
}
