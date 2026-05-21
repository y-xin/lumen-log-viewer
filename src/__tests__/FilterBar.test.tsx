import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { FilterBar } from '../components/FilterBar';
import { useSession } from '../state/session';

describe('FilterBar', () => {
  it('toggles level on click', () => {
    // 准备：先注入一个虚假 metadata 让 FilterBar 显示
    useSession.setState({
      metadata: {
        path: '/x', total: 0, time_range: null, level_counts: {},
        scopes: [], template_id: 'json-lines',
      },
      spec: { levels: ['info', 'warn'] },
    });

    render(<FilterBar />);
    const infoBtn = screen.getByRole('button', { name: /info/i });
    fireEvent.click(infoBtn);

    // INFO 被取消，预期 spec.levels 只剩 ['warn']
    const { spec } = useSession.getState();
    expect(spec.levels?.includes('info')).toBe(false);
    expect(spec.levels?.includes('warn')).toBe(true);
  });
});
