import {
  AuditLog,
  InitiativeManager,
  MdocsLinter,
  MdocsManager,
  SearchEngine,
  SubagentAssembler,
  WikiManager,
  WorkflowEngine
} from '../../src/core';

test('core managers are exported from the core barrel', () => {
  expect(MdocsManager).toBeDefined();
  expect(InitiativeManager).toBeDefined();
  expect(WikiManager).toBeDefined();
  expect(WorkflowEngine).toBeDefined();
  expect(SearchEngine).toBeDefined();
  expect(AuditLog).toBeDefined();
  expect(MdocsLinter).toBeDefined();
  expect(SubagentAssembler).toBeDefined();
});
