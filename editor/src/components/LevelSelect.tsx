import { useEditorState } from '../state/EditorContext.tsx';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select';

interface LevelSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  triggerClassName?: string;
}

/**
 * A select component that displays project levels by name (with elevation),
 * using level IDs as values.
 */
export function LevelSelect({ value, onValueChange, triggerClassName }: LevelSelectProps) {
  const state = useEditorState();
  const levels = state.project?.levels ?? [];
  const sorted = [...levels].sort((a, b) => a.elevation - b.elevation);

  const formatLevel = (id: string) => {
    const level = levels.find(l => l.id === id);
    if (!level) return id;
    return `${level.name || level.number || level.id} (${level.elevation}m)`;
  };

  return (
    <Select value={value} onValueChange={(v) => { if (v) onValueChange(v); }}>
      <SelectTrigger className={triggerClassName}>
        <SelectValue placeholder={formatLevel(value)} />
      </SelectTrigger>
      <SelectContent>
        {sorted.map(l => (
          <SelectItem key={l.id} value={l.id}>
            {l.name || l.number || l.id} ({l.elevation}m)
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
