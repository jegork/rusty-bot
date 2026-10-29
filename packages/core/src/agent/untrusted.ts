const UNTRUSTED_TAG_RE = /<(\/?)untrusted-/gi;

/**
 * wrap pull-request-controlled text in delimiter tags the model is told to treat as data.
 * any untrusted-* tag already inside the content is defanged so it cannot close its wrapper.
 */
export function wrapUntrusted(label: string, content: string): string {
  const safe = content.replace(UNTRUSTED_TAG_RE, "<$1untrusted_");
  return `<untrusted-${label}>\n${safe}\n</untrusted-${label}>`;
}
