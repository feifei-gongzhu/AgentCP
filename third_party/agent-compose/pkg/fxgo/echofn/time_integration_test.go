package echofn

import "testing"

func TestEpochTimeAPIWorkflow(t *testing.T) {
	testEpochTimeAPIEncodesNestedBsonDDateTimeAsFloat(t)
}

func TestIntegrationEpochTimeAPIWorkflow(t *testing.T) {
	testEpochTimeAPIEncodesNestedBsonDDateTimeAsFloat(t)
}

func TestE2EEpochTimeAPIWorkflow(t *testing.T) {
	testEpochTimeAPIEncodesNestedBsonDDateTimeAsFloat(t)
}
