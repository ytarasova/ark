export interface Event {
  id: number;
  track_id: string;
  type: string;
  stage: string | null;
  actor: string | null;
  data: Record<string, unknown> | null;
  created_at: string;
}
