import React from 'react';
import { IconChevronLeft, IconChevronRight } from './Icons';

export interface PanelNavItem {
  id: string;
  label: string;
  buttonId: string;
  icon: React.ReactNode;
  isOpen: boolean;
  onToggle: () => void;
}

interface RightSidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  items: PanelNavItem[];
  style?: React.CSSProperties;
}

export const RightSidebar: React.FC<RightSidebarProps> = React.memo(({
  collapsed,
  onToggleCollapse,
  items,
  style,
}) => {
  return (
    <aside
      className={`right-sidebar ${collapsed ? 'collapsed' : ''}`}
      id="rightSidebar"
      style={style}
      aria-label="Panel Navigation Sidebar"
    >
      <div className="right-sidebar-head">
        <button
          className="icon-btn small right-sidebar-toggle"
          id="rightSidebarToggle"
          title={collapsed ? 'Expand right sidebar' : 'Collapse right sidebar'}
          onClick={onToggleCollapse}
          type="button"
          aria-label={collapsed ? 'Expand right sidebar' : 'Collapse right sidebar'}
          aria-expanded={!collapsed}
        >
          {collapsed ? <IconChevronLeft size={13} /> : <IconChevronRight size={13} />}
        </button>
      </div>

      <div className="right-sidebar-nav">
        {items.map((item) => (
          <button
            key={item.id}
            className={`right-sidebar-btn ${item.isOpen ? 'active' : 'docked'}`}
            id={item.buttonId}
            title={`${item.label} (${item.isOpen ? 'Open — click to close' : 'Collapsed — click to open'})`}
            onClick={item.onToggle}
            type="button"
            aria-pressed={item.isOpen}
            aria-label={`Toggle ${item.label} panel`}
          >
            {item.isOpen && <span className="right-sidebar-active-bar" />}
            {item.icon}
            <span className="right-sidebar-tooltip" aria-hidden="true">
              {item.label}
              <small>{item.isOpen ? 'Open' : 'Collapsed'}</small>
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
});

RightSidebar.displayName = 'RightSidebar';
