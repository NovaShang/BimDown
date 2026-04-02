import { useEditorState } from '../state/EditorContext.tsx';
import { Select, SelectTrigger, SelectContent, SelectItem } from './ui/select';

interface LevelSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  triggerClassName?: string;
  size?: 'sm' | 'default';
}

function formatLevelName(levels: { id: string; number: string; name: string; elevation: number }[], id: string) {
  const level = levels.find(l => l.id === id);
  if (!level) return id;
  return level.name || level.number || level.id;
}

export function LevelSelect({ value, onValueChange, triggerClassName, size }: LevelSelectProps) {
  const state = useEditorState();
  const levels = state.project?.levels ?? [];
  const sorted = [...levels].sort((a, b) => a.elevation - b.elevation);

  return (
    <Select value={value} onValueChange={(v) => { if (v) onValueChange(v); }}>
      <SelectTrigger size={size} className={triggerClassName}>
        <span className="truncate">{formatLevelName(levels, value)}</span>
      </SelectTrigger>
      <SelectContent>
        {sorted.map(l => (
          <SelectItem key={l.id} value={l.id}>
            {l.name || l.number || l.id}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
