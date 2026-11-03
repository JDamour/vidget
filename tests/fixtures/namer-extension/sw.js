// Stands in for any installed extension that watches every download, as download
// managers do. Chrome then runs its filename step, even though this suggests nothing.
chrome.downloads.onDeterminingFilename.addListener((_item, suggest) => {
  suggest();
});
