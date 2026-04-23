// Existing components
export { Badge, badgeVariants, StatusBadge, TagChip, AgentChip, RuntimeChip, ComputeChip } from "./badge.js";
export type { StatusBadgeProps, StatusBadgeStatus, TagChipProps } from "./badge.js";
export { RichSelect } from "./RichSelect.js";
export type { RichSelectOption, RichSelectProps } from "./RichSelect.js";
export { Button, buttonVariants } from "./button.js";
export { Card, CardHeader, CardTitle, CardDescription, CardContent } from "./card.js";
export {
  Input,
  InputShell,
  InputUnderline,
  InputField,
  HelperText,
  CheckIcon,
  WarnIcon,
  ErrorIcon,
  Spinner,
} from "./input.js";
export type { InputProps, InputShellProps, InputFieldProps, InputState, HelperTextProps } from "./input.js";
export { Textarea } from "./textarea.js";
export type { TextareaProps } from "./textarea.js";
export { Select } from "./select.js";
export type { SelectOption, SelectProps } from "./select.js";
export { Checkbox } from "./checkbox.js";
export type { CheckboxProps } from "./checkbox.js";
export { Radio, RadioGroup } from "./radio.js";
export type { RadioProps } from "./radio.js";
export { Toggle } from "./toggle.js";
export type { ToggleProps } from "./toggle.js";
export { Modal } from "./modal.js";
export { Separator } from "./separator.js";

// Design system -- layout
export { IconRail } from "./IconRail.js";
export type { IconRailItem, IconRailProps } from "./IconRail.js";
export { SessionList } from "./SessionList.js";
export type { SessionListItem, SessionListProps } from "./SessionList.js";
export { SessionHeader } from "./SessionHeader.js";
export type { SessionHeaderProps } from "./SessionHeader.js";
export { ContentTabs } from "./ContentTabs.js";
export type { TabDef, ContentTabsProps } from "./ContentTabs.js";
export { WorkspacePanel } from "./WorkspacePanel.js";
export type { WorkspacePanelProps } from "./WorkspacePanel.js";
export { ChatInput } from "./ChatInput.js";
export type { ChatInputProps } from "./ChatInput.js";

// Design system -- conversation
export { AgentMessage } from "./AgentMessage.js";
export type { AgentMessageProps } from "./AgentMessage.js";
export { MarkdownContent } from "./MarkdownContent.js";
export { UserMessage } from "./UserMessage.js";
export type { UserMessageProps } from "./UserMessage.js";
export { SystemEvent } from "./SystemEvent.js";
export type { SystemEventProps } from "./SystemEvent.js";
export { ToolCallRow } from "./ToolCallRow.js";
export type { ToolCallRowProps } from "./ToolCallRow.js";
export { ToolCallFailed } from "./ToolCallFailed.js";
export type { ToolCallFailedProps } from "./ToolCallFailed.js";
export { ReviewFinding } from "./ReviewFinding.js";
export type { ReviewFindingProps } from "./ReviewFinding.js";
export { SessionSummary } from "./SessionSummary.js";
export type { SessionSummaryProps } from "./SessionSummary.js";
export { TypingIndicator } from "./TypingIndicator.js";
export type { TypingIndicatorProps } from "./TypingIndicator.js";

// Design system -- status
export { StageProgressBar, SessionLane } from "./StageProgressBar.js";
export type { StageProgress, StageProgressBarProps, SessionLaneProps } from "./StageProgressBar.js";
export { StagePipeline } from "./StagePipeline.js";
export type { StagePipelineProps } from "./StagePipeline.js";
export { FlowDag, stagesToFlowDagNodes } from "./FlowDag.js";
export type { FlowDagProps, FlowDagNode } from "./FlowDag.js";
export { StatusDot } from "./StatusDot.js";
export type { SessionStatus, StatusDotProps } from "./StatusDot.js";
export { FilterChip } from "./FilterChip.js";
export type { FilterChipProps } from "./FilterChip.js";
export { IntegrationPill } from "./IntegrationPill.js";
export type { IntegrationPillProps } from "./IntegrationPill.js";
export { TabBadge } from "./TabBadge.js";
export type { TabBadgeProps } from "./TabBadge.js";

// Design system -- general
export { CommandPalette } from "./CommandPalette.js";
export type { CommandItem, CommandPaletteProps } from "./CommandPalette.js";
export { ScrollProgress } from "./ScrollProgress.js";
export type { ScrollProgressProps } from "./ScrollProgress.js";
export { Avatar } from "./Avatar.js";
export type { AvatarProps } from "./Avatar.js";
export { DiffViewer } from "./DiffViewer.js";
export type { DiffFile, DiffLine, DiffViewerProps } from "./DiffViewer.js";
export { EventTimeline } from "./EventTimeline.js";
export type { TimelineEvent, EventTimelineProps } from "./EventTimeline.js";
export { TodoList } from "./TodoList.js";
export type { TodoItem, TodoListProps } from "./TodoList.js";
