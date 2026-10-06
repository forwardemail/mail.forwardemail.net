import { describe, expect, it } from 'vitest';
import { parseAgentsPath } from '../../src/utils/agents-route';

describe('parseAgentsPath', () => {
  it.each([
    ['/agents', { screen: 'queue', section: 'waiting' }],
    ['/agents/', { screen: 'queue', section: 'waiting' }],
    ['/agents/unusual', { screen: 'queue', section: 'unusual' }],
    ['/agents/done', { screen: 'queue', section: 'done' }],
    ['/agents/actions/act_1', { screen: 'action', id: 'act_1' }],
    ['/agents/actions', { screen: 'queue', section: 'waiting' }],
    ['/agents/threads', { screen: 'threads' }],
    ['/agents/threads/thr_9', { screen: 'thread', id: 'thr_9' }],
    ['/agents/audit', { screen: 'audit' }],
    ['/agents/policies', { screen: 'policies' }],
    ['/agents/agt_2', { screen: 'agent', id: 'agt_2' }],
    ['/agents/agt%202', { screen: 'agent', id: 'agt 2' }],
  ])('%s', (path, expected) => {
    expect(parseAgentsPath(path)).toEqual(expected);
  });
});
