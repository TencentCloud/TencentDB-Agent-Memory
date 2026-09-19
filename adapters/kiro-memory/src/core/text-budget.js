export const unicodeLength = (value) => [...value].length;

export function truncateWithMarker(value, maxChars) {
  const characters = [...value];
  if (characters.length <= maxChars) return value;
  const marker = `<TRUNCATED original_chars=${characters.length}>`;
  const markerChars = [...marker];
  if (markerChars.length > maxChars) return '';
  return `${characters.slice(0, maxChars - markerChars.length).join('')}${marker}`;
}
