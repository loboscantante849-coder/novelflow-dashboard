'use strict';

const STATES = Object.freeze({
  REQUESTED: 'requested',
  CODE_ALLOCATED: 'code_allocated',
  LINK_CREATED: 'link_created',
  PERSISTED: 'persisted',
  COMPLETED: 'completed',
  PENDING: 'pending',
  FAILED: 'failed',
});

const transitions = new Map([
  [STATES.REQUESTED, new Set([STATES.CODE_ALLOCATED, STATES.PENDING, STATES.FAILED])],
  [STATES.CODE_ALLOCATED, new Set([STATES.LINK_CREATED, STATES.PENDING, STATES.FAILED])],
  [STATES.LINK_CREATED, new Set([STATES.PERSISTED, STATES.PENDING, STATES.FAILED])],
  [STATES.PERSISTED, new Set([STATES.COMPLETED, STATES.PENDING, STATES.FAILED])],
  [STATES.COMPLETED, new Set()],
  [STATES.PENDING, new Set([STATES.CODE_ALLOCATED, STATES.LINK_CREATED, STATES.PERSISTED, STATES.COMPLETED, STATES.FAILED])],
  [STATES.FAILED, new Set([STATES.REQUESTED, STATES.CODE_ALLOCATED, STATES.PENDING])],
]);

function canTransition(from, to) {
  return Boolean(transitions.get(from)?.has(to));
}

function transition(record, to, details = {}) {
  const from = record?.state || STATES.REQUESTED;
  if (!canTransition(from, to)) {
    const error = new Error(`Invalid promotion transition: ${from} -> ${to}`);
    error.code = 'INVALID_PROMOTION_TRANSITION';
    throw error;
  }
  return { ...record, ...details, state: to, updatedAt: details.updatedAt || new Date().toISOString() };
}

module.exports = { STATES, canTransition, transition };
