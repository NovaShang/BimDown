import { useEditorState } from '../state/EditorContext.tsx';
import { Select, SelectTrigger, SelectContent, SelectItem } from './ui/select';
import { useTranslation } from 'react-i18next';
import { levelLabel } from '../model/displayNames.ts';

interface LevelSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  triggerClassName?: string;
  size?: 'sm' | 'default';
}


export function LevelSelect({ value, onValueChange, triggerClassName, size }: LevelSelectProps) {
  const { t } = useTranslation();
  const state = useEditorState();
  const levels = state.project?.levels ?? [];
  const current = levels.find(l => l.id === value);
  const sorted = [...levels].sort((a, b) => a.elevation - b.elevation);

  return (
    <Select value={value} onValueChange={(v) => { if (v) onValueChange(v); }}>
      <SelectTrigger size={size} className={triggerClassName}>
        <span className="truncate">{current ? levelLabel(t, current) : value}</span>
      </SelectTrigger>
      <SelectContent>
        {sorted.map(l => (
          <SelectItem key={l.id} value={l.id}>
            {levelLabel(t, l)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
