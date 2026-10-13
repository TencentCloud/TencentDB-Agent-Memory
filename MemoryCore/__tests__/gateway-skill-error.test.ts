import { expect, it } from 'vitest';
import { TdaiGateway } from '../src/gateway/server.js';
import { SkillCoreError } from '../src/core/skill/skill-core.js';

// Exercise actual private methods through their runtime descriptors with synthetic
// receivers. No constructor, storage, LLM request or production state is used.
function method(name: string): (...args: unknown[]) => Promise<unknown> {
  const value: unknown = Object.getOwnPropertyDescriptor(TdaiGateway.prototype, name)?.value;
  if (typeof value !== 'function') throw new Error(`Missing method ${name}`);
  return value as (...args: unknown[]) => Promise<unknown>;
}
it('reports the expected skill error when instance dependencies are absent', async () => {
  await expect(method('resolveSkillCoreForInstance').call({}, 'synthetic')).rejects.toBeInstanceOf(SkillCoreError);
  await expect(method('resolveSkillCoreForInstance').call({}, 'synthetic')).rejects.toMatchObject({ code: 'SKILL_COS_REQUIRED' });
});
it.each([{}, { baseUrl: 'https://invalid.example', provider: 'openai' }])('reports missing LLM configuration without calling a provider: %j', async llm => {
  await expect(method('buildSkillExtractorForInstance').call({ config: { llm } }, {}, 'synthetic')).rejects.toBeInstanceOf(SkillCoreError);
  await expect(method('buildSkillExtractorForInstance').call({ config: { llm } }, {}, 'synthetic')).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
});
