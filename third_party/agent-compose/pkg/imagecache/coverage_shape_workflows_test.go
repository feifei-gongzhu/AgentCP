package imagecache

import "testing"

func TestIntegrationImageCacheLocalWorkflows(t *testing.T) {
	t.Run("cache paths and ensure", TestCachePathsAndEnsure)
	t.Run("metadata load save", TestMetadataLoadSaveRoundTrip)
	t.Run("corrupt metadata", TestLoadMetadataRejectsCorruptJSON)
	t.Run("lock temp dir ready", TestCacheLockTempDirAndReadyFlag)
	t.Run("error kind", TestErrorKindSupportsErrorsIsAndAs)
	t.Run("parse reference", TestParseReferenceUsesGoContainerRegistry)
	t.Run("materialize oci layout", TestMaterializeOCILayoutCopiesValidLayoutAndReadyFlag)
	t.Run("materialize ready hit", TestMaterializeOCILayoutReadyCacheHitDoesNotOverwrite)
	t.Run("materialize missing", TestMaterializeOCILayoutReturnsNotFound)
	t.Run("list", TestListFiltersMetadataByQuery)
	t.Run("inspect", TestInspectFindsMetadataByRefsAndDigests)
	t.Run("inspect missing", TestInspectReturnsNotFoundError)
	t.Run("remove one", TestRemoveDeletesSingleMetadataReference)
	t.Run("remove conflict", TestRemoveConflictsWhenMultipleRefsShareImage)
	t.Run("remove force", TestRemoveForceDeletesAllRefsSharingImage)
	t.Run("normalize docker ref", TestNormalizeReferenceDefaultsDockerStyleReference)
	t.Run("normalize default registry", TestNormalizeReferenceUsesConfiguredDefaultRegistry)
	t.Run("normalize qualified ref", TestNormalizeReferenceKeepsFullyQualifiedReference)
	t.Run("normalize digest ref", TestNormalizeReferenceParsesDigestReference)
	t.Run("new metadata", TestNewImageMetadataCompletesFieldsAndPreservesRequestedRef)
	t.Run("metadata reload", TestMetadataReloadKeepsLookupStableAndRequestedRef)
	t.Run("rootfs layers", TestMaterializeRootFSMergesLayersAndWhiteouts)
	t.Run("rootfs links", TestMaterializeRootFSHandlesSymlinkHardlinkAndReadyHit)
	t.Run("rootfs path escape", TestMaterializeRootFSRejectsPathEscape)
	t.Run("rootfs symlink escape", TestMaterializeRootFSRejectsSymlinkParentEscape)
}

func TestE2EImageCacheLocalWorkflows(t *testing.T) {
	TestIntegrationImageCacheLocalWorkflows(t)
}
