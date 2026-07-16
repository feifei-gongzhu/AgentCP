package capability

import (
	"sort"
)

type octobusStatusResponse struct {
	Status   string `json:"status"`
	Services int    `json:"services"`
}

type octobusCapsetsResponse struct {
	Capsets []octobusCapset `json:"capsets"`
}

type octobusCapset struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Enabled     bool   `json:"enabled"`
}

type octobusCatalogResponse struct {
	CapsetID    string                  `json:"capset_id"`
	Name        string                  `json:"name"`
	Description string                  `json:"description"`
	GRPC        []octobusGRPCItem       `json:"grpc"`
	MCP         []octobusMCPItem        `json:"mcp"`
	ConnectRPC  []octobusConnectRPCItem `json:"connect_rpc"`
}

type octobusGRPCItem struct {
	ServiceID               string            `json:"service_id"`
	RuntimeMode             string            `json:"runtime_mode"`
	InstanceID              string            `json:"instance_id"`
	MethodFullName          string            `json:"method_full_name"`
	MethodPath              string            `json:"method_path"`
	Metadata                map[string]string `json:"metadata"`
	RequestMessageFullName  string            `json:"request_message_full_name"`
	ResponseMessageFullName string            `json:"response_message_full_name"`
	BackendInstanceStatus   string            `json:"backend_instance_status"`
}

type octobusMCPItem struct {
	ServiceID               string `json:"service_id"`
	RuntimeMode             string `json:"runtime_mode"`
	InstanceID              string `json:"instance_id"`
	MethodFullName          string `json:"method_full_name"`
	Endpoint                string `json:"endpoint"`
	ToolName                string `json:"tool_name"`
	RequestMessageFullName  string `json:"request_message_full_name"`
	ResponseMessageFullName string `json:"response_message_full_name"`
	BackendInstanceStatus   string `json:"backend_instance_status"`
}

type octobusConnectRPCItem struct {
	ServiceID               string   `json:"service_id"`
	RuntimeMode             string   `json:"runtime_mode"`
	InstanceID              string   `json:"instance_id"`
	MethodFullName          string   `json:"method_full_name"`
	Procedure               string   `json:"procedure"`
	Endpoint                string   `json:"endpoint"`
	HTTPMethod              string   `json:"http_method"`
	ContentTypes            []string `json:"content_types"`
	RequestMessageFullName  string   `json:"request_message_full_name"`
	ResponseMessageFullName string   `json:"response_message_full_name"`
	BackendInstanceStatus   string   `json:"backend_instance_status"`
}

func NormalizeCatalog(raw octobusCatalogResponse) (Catalog, error) {
	methods := map[string]*Method{}
	for _, item := range raw.GRPC {
		key := methodKey(item.ServiceID, item.InstanceID, item.MethodFullName)
		method := ensureMethod(methods, key, item.ServiceID, item.InstanceID, item.RuntimeMode, item.MethodFullName, item.RequestMessageFullName, item.ResponseMessageFullName, item.BackendInstanceStatus)
		method.Endpoints = append(method.Endpoints, Endpoint{
			Protocol:   ProtocolGRPC,
			MethodPath: item.MethodPath,
			Metadata:   cloneMap(item.Metadata),
		})
	}
	for _, item := range raw.MCP {
		key := methodKey(item.ServiceID, item.InstanceID, item.MethodFullName)
		method := ensureMethod(methods, key, item.ServiceID, item.InstanceID, item.RuntimeMode, item.MethodFullName, item.RequestMessageFullName, item.ResponseMessageFullName, item.BackendInstanceStatus)
		method.Endpoints = append(method.Endpoints, Endpoint{
			Protocol: ProtocolMCP,
			Endpoint: item.Endpoint,
			ToolName: item.ToolName,
		})
	}
	for _, item := range raw.ConnectRPC {
		key := methodKey(item.ServiceID, item.InstanceID, item.MethodFullName)
		method := ensureMethod(methods, key, item.ServiceID, item.InstanceID, item.RuntimeMode, item.MethodFullName, item.RequestMessageFullName, item.ResponseMessageFullName, item.BackendInstanceStatus)
		method.Endpoints = append(method.Endpoints, Endpoint{
			Protocol:     ProtocolConnect,
			Endpoint:     item.Endpoint,
			Procedure:    item.Procedure,
			HTTPMethod:   item.HTTPMethod,
			ContentTypes: append([]string(nil), item.ContentTypes...),
		})
	}

	out := Catalog{
		CapsetID:    raw.CapsetID,
		Name:        raw.Name,
		Description: raw.Description,
		Methods:     make([]Method, 0, len(methods)),
	}
	for _, method := range methods {
		out.Methods = append(out.Methods, *method)
	}
	sort.Slice(out.Methods, func(i, j int) bool {
		if out.Methods[i].MethodFullName != out.Methods[j].MethodFullName {
			return out.Methods[i].MethodFullName < out.Methods[j].MethodFullName
		}
		if out.Methods[i].ServiceID != out.Methods[j].ServiceID {
			return out.Methods[i].ServiceID < out.Methods[j].ServiceID
		}
		return out.Methods[i].InstanceID < out.Methods[j].InstanceID
	})
	return out, nil
}

func ensureMethod(methods map[string]*Method, key, serviceID, instanceID, runtimeMode, methodFullName, requestName, responseName, backendStatus string) *Method {
	if method, ok := methods[key]; ok {
		return method
	}
	methods[key] = &Method{
		ServiceID:               serviceID,
		InstanceID:              instanceID,
		RuntimeMode:             runtimeMode,
		MethodFullName:          methodFullName,
		RequestMessageFullName:  requestName,
		ResponseMessageFullName: responseName,
		BackendInstanceStatus:   backendStatus,
	}
	return methods[key]
}

func methodKey(serviceID, instanceID, methodFullName string) string {
	return serviceID + "\x00" + instanceID + "\x00" + methodFullName
}

func cloneMap(in map[string]string) map[string]string {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
