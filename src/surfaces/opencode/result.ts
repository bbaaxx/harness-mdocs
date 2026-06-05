export function toOpencodeToolResult(value: any) {
  if (typeof value === 'string') return value;
  if (value && typeof value.output === 'string') return value;
  return {
    output: JSON.stringify(value, null, 2),
    metadata: value && typeof value === 'object' ? value : { value }
  };
}

export function wrapOpencodeToolResults(plugin: any) {
  if (!plugin?.tool) return plugin;
  for (const definition of Object.values(plugin.tool) as any[]) {
    if (!definition || typeof definition.execute !== 'function') continue;
    const execute = definition.execute.bind(definition);
    definition.execute = async (...args: any[]) => toOpencodeToolResult(await execute(...args));
  }
  return plugin;
}
