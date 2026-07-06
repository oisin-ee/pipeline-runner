export const PACKAGE_ASSET_ROOT = new URL("..", import.meta.url);

export const resolvePackageAssetPath = (path: string): string => new URL(path, PACKAGE_ASSET_ROOT).pathname;
