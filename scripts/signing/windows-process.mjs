export function windowsPowerShellEnvironment(source = process.env) {
  return Object.fromEntries(
    Object.entries(source).filter(([name]) => name.toLowerCase() !== "psmodulepath")
  );
}
