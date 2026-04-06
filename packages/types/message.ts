export type MessageRole = "user" | "agent" | "system";
export type MessageType = "text" | "progress" | "question" | "completed" | "error";

export interface Message {
  id: number;
  session_id: string;
  role: MessageRole;
  content: string;
  type: MessageType;
  read: boolean;
  created_at: string;
}
