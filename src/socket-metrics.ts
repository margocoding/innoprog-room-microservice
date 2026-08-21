type Labels = Record<string, string>;

const labelKey = (labels: Labels): string =>
  Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');

const renderLabels = (key: string): string => {
  if (!key) return '';
  const values = key.split(',').map((entry) => {
    const separator = entry.indexOf('=');
    const name = entry.slice(0, separator);
    const value = entry
      .slice(separator + 1)
      .replaceAll('\\', '\\\\')
      .replaceAll('"', '\\"');
    return `${name}="${value}"`;
  });
  return `{${values.join(',')}}`;
};

export class SocketMetrics {
  private readonly counters = new Map<string, number>();
  private readonly summaries = new Map<string, { count: number; sum: number }>();

  increment(name: string, labels: Labels = {}): void {
    const key = `${name}|${labelKey(labels)}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  observe(name: string, value: number, labels: Labels = {}): void {
    const key = `${name}|${labelKey(labels)}`;
    const current = this.summaries.get(key) ?? { count: 0, sum: 0 };
    current.count += 1;
    current.sum += Math.max(0, value);
    this.summaries.set(key, current);
  }

  render(): string {
    const lines: string[] = [];
    const emitted = new Set<string>();
    for (const [key, value] of [...this.counters.entries()].sort()) {
      const [name, labels = ''] = key.split('|', 2);
      if (!emitted.has(name)) {
        lines.push(`# TYPE ${name} counter`);
        emitted.add(name);
      }
      lines.push(`${name}${renderLabels(labels)} ${value}`);
    }
    for (const [key, value] of [...this.summaries.entries()].sort()) {
      const [name, labels = ''] = key.split('|', 2);
      if (!emitted.has(name)) {
        lines.push(`# TYPE ${name} summary`);
        emitted.add(name);
      }
      const suffix = renderLabels(labels);
      lines.push(`${name}_count${suffix} ${value.count}`);
      lines.push(`${name}_sum${suffix} ${value.sum.toFixed(6)}`);
    }
    return `${lines.join('\n')}\n`;
  }

  reset(): void {
    this.counters.clear();
    this.summaries.clear();
  }
}

export const socketMetrics = new SocketMetrics();
