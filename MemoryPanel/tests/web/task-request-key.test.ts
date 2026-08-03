import { describe, expect, it } from 'vitest';
import { taskRequestKey } from '../../web/src/stores/task-request-key';

describe('taskRequestKey', () => {
  it('deduplicates identical requests within one team', () => {
    expect(taskRequestKey('team-a', 20, 10)).toBe(
      taskRequestKey('team-a', 20, 10),
    );
  });

  it('keeps the same page independent across teams', () => {
    expect(taskRequestKey('team-a', 0, 20)).not.toBe(
      taskRequestKey('team-b', 0, 20),
    );
  });
});
