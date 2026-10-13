import { expect, it } from 'vitest';
import { formatSkillFile, parseSkillFile, validateSkillFile } from '../src/core/skill/skill-format.js';

it('preserves coerced frontmatter values and resource/body round trips', () => {
  const raw = '---\r\nname: 123\r\ndescription: false\r\nresources:\r\n  - path: synthetic.txt\r\n    type: text\r\n---\r\n\r\nSynthetic body';
  const file = parseSkillFile(raw);
  expect(file.frontmatter.name).toBe('123');
  expect(file.frontmatter.description).toBe('false');
  expect(file.raw).toBe(raw);
  validateSkillFile(file);
  const roundTrip = parseSkillFile(formatSkillFile(file));
  expect(roundTrip.frontmatter).toEqual(file.frontmatter);
  expect(roundTrip.body).toBe(file.body);
});
it('continues rejecting unsupported resource types after parsing', () => {
  const file = parseSkillFile('---\nname: synthetic\ndescription: synthetic\nresources:\n  - path: synthetic.txt\n    type: unsupported\n---\n');
  expect(() => validateSkillFile(file)).toThrow('resource type');
});
