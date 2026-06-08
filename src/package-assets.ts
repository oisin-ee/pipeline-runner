const PACKAGE_ASSET_ROOT = new URL("..", import.meta.url);

export function resolvePackageAssetPath(path: string | undefined): string {
  return new URL(path ?? "", PACKAGE_ASSET_ROOT).pathname;
}
