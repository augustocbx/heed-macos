export interface TaskEvidence {
 segmentIndex: number;
 sourceRevision: string;
 speaker: string;
 start: number | null;
 end: number | null;
 quote: string;
}
export interface TaskFields {
 title: string;
 description: string;
 assignee: string | null;
 dueDate: string | null;
}
export interface TaskSuggestion extends TaskFields {
 id: string;
 kind: 'explicit' | 'inferred';
 evidence: TaskEvidence[];
 dateReview: string | null;
 state: 'suggested' | 'accepted' | 'dismissed';
 acceptedTaskId?: string;
}
export interface TaskReview {
 sessionId: string;
 sourceRevision: string;
 status: 'queued' | 'running' | 'waiting' | 'ready' | 'failed' | 'superseded';
 error?: string;
 suggestions: TaskSuggestion[];
 updatedAt: string;
}
export interface MeetingTask extends TaskFields {
 id: string;
 revision: string;
 sessionId: string;
 meetingTitle: string;
 suggestionId: string;
 sourceRevision: string;
 evidence: TaskEvidence[];
 kind: TaskSuggestion['kind'];
 status: 'open' | 'completed';
 completedAt: string | null;
 createdAt: string;
 updatedAt: string;
}
export interface TaskView extends MeetingTask {
 sourceState: 'available' | 'transcript-changed' | 'meeting-deleted';
 audioAvailable: boolean;
}
export interface TasksSnapshot { tasks: TaskView[]; review?: TaskReview; }
export interface AcceptTaskInput extends TaskFields { suggestionId: string; }
export type TaskPatch = Partial<TaskFields> & { status?: MeetingTask['status'] };
