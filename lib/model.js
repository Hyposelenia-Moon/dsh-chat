/** ACP values are opaque. The pinned DSH represents a route as a JSON pair. */
export function normalizeModelOptions(configOptions = []) {
  const option = configOptions.find(item => item.id === 'model');
  const result = [];
  for (const group of option?.options ?? []) {
    const entries = Array.isArray(group.options) ? group.options : [group];
    for (const entry of entries) {
      let provider = group.group ?? '', model = entry.value;
      try {
        const pair = JSON.parse(entry.value);
        if (Array.isArray(pair) && pair.length === 2) [provider, model] = pair;
      } catch { /* Other ACP implementations may use different opaque strings. */ }
      result.push({ ...entry, provider, model, value: entry.value,
        isFree: /our-free-model/.test(provider) || /(?:\/free|:free)$/.test(model),
        selected: option.currentValue === entry.value });
    }
  }
  return result;
}

export function resolveModelValue(configOptions, configured) {
  const found = normalizeModelOptions(configOptions).find(item =>
    item.value === configured || `${item.provider}/${item.model}` === configured);
  if (!found) throw new Error(`模型未出现在 ACP 模型列表中：${configured}`);
  return found.value;
}

export function currentModel(configOptions = []) {
  return normalizeModelOptions(configOptions).find(item => item.selected);
}

export function validateOption(configOptions, configId, value) {
  const option = configOptions.find(item => item.id === configId);
  if (!option || option.type !== 'select') throw new Error(`ACP 未提供此配置：${configId}`);
  const choices = option.options.flatMap(item => item.options ?? [item]);
  if (!choices.some(item => item.value === value)) throw new Error(`ACP 配置值不可用：${configId}`);
  return value;
}
