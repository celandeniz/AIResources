import { EventEmitter } from 'node:events';

export type StreamEvent = {
  type: 'activity' | 'approval' | 'notification' | 'project' | 'coverage';
  workspaceId?: string | null;
  payload: unknown;
};

export const streamEvents = new EventEmitter();
streamEvents.setMaxListeners(200);

export function emitStreamEvent(event: StreamEvent) {
  streamEvents.emit('event', event);
}
