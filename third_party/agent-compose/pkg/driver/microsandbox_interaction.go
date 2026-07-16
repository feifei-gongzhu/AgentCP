package driver

import "context"

func (r *microsandboxRuntime) InteractionCapabilities() RuntimeInteractionCapabilities {
	return RuntimeInteractionCapabilities{}
}

func (r *microsandboxRuntime) OpenInteraction(ctx context.Context, session *Sandbox, vmState VMState, spec RuntimeStartSpec) (RuntimeInteraction, error) {
	return UnsupportedRuntimeInteraction(RuntimeDriverMicrosandbox, r.InteractionCapabilities(), spec)
}
