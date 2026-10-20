export function normalizePath(file: string): string {
  return file
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/:\d+(?::\d+)?$/, "");
}
