import React from 'react';
import { IconDoc, IconChat, IconPencil, IconChevronLeft, IconChevronRight, IconRef } from './Icons';

interface RightSidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  isViewerOpen: boolean;
  onToggleViewer: () => void;
  isChatOpen: boolean;
  onToggleChat: () => void;
  isNotesOpen: boolean;
  onToggleNotes: () => void;
  isAssetsOpen: boolean;
  onToggleAssets: () => void;
  isBibtexOpen: boolean;
  onToggleBibtex: () => void;
  style?: React.CSSProperties;
}

export const RightSidebar: React.FC<RightSidebarProps> = React.memo(({
  collapsed,
  onToggleCollapse,
  isViewerOpen,
  onToggleViewer,
  isChatOpen,
  onToggleChat,
  isNotesOpen,
  onToggleNotes,
  isAssetsOpen,
  onToggleAssets,
  isBibtexOpen,
  onToggleBibtex,
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
        <button
          className={`right-sidebar-btn ${isViewerOpen ? 'active' : 'docked'}`}
          id="sidebarBtnViewer"
          title={`PDF Viewer (${isViewerOpen ? 'Open — click to close' : 'Collapsed — click to open'})`}
          onClick={onToggleViewer}
          type="button"
          aria-pressed={isViewerOpen}
          aria-label="Toggle PDF Viewer panel"
        >
          {isViewerOpen && <span className="right-sidebar-active-bar" />}
          <IconDoc size={17} />
          <span className="right-sidebar-tooltip" aria-hidden="true">
            PDF Viewer
            <small>{isViewerOpen ? 'Open' : 'Collapsed'}</small>
          </span>
        </button>

        <button
          className={`right-sidebar-btn ${isChatOpen ? 'active' : 'docked'}`}
          id="sidebarBtnChat"
          title={`AI Chat (${isChatOpen ? 'Open — click to close' : 'Collapsed — click to open'})`}
          onClick={onToggleChat}
          type="button"
          aria-pressed={isChatOpen}
          aria-label="Toggle Chat panel"
        >
          {isChatOpen && <span className="right-sidebar-active-bar" />}
          <IconChat size={17} />
          <span className="right-sidebar-tooltip" aria-hidden="true">
            AI Chat
            <small>{isChatOpen ? 'Open' : 'Collapsed'}</small>
          </span>
        </button>

        <button
          className={`right-sidebar-btn ${isNotesOpen ? 'active' : 'docked'}`}
          id="sidebarBtnNotes"
          title={`Notes Editor (${isNotesOpen ? 'Open — click to close' : 'Collapsed — click to open'})`}
          onClick={onToggleNotes}
          type="button"
          aria-pressed={isNotesOpen}
          aria-label="Toggle Notes panel"
        >
          {isNotesOpen && <span className="right-sidebar-active-bar" />}
          <IconPencil size={17} />
          <span className="right-sidebar-tooltip" aria-hidden="true">
            Notes
            <small>{isNotesOpen ? 'Open' : 'Collapsed'}</small>
          </span>
        </button>
        <button
          className={`right-sidebar-btn ${isAssetsOpen ? 'active' : 'docked'}`}
          id="sidebarBtnAssets"
          title={`Assets (${isAssetsOpen ? 'Open — click to close' : 'Collapsed — click to open'})`}
          onClick={onToggleAssets}
          type="button"
          aria-pressed={isAssetsOpen}
          aria-label="Toggle Assets panel"
        >
          {isAssetsOpen && <span className="right-sidebar-active-bar" />}
          <IconDoc size={17} />
          <span className="right-sidebar-tooltip" aria-hidden="true">
            Assets
            <small>{isAssetsOpen ? 'Open' : 'Collapsed'}</small>
          </span>
        </button>

        <button
          className={`right-sidebar-btn ${isBibtexOpen ? 'active' : 'docked'}`}
          id="sidebarBtnBibtex"
          title={`BibTeX (${isBibtexOpen ? 'Open — click to close' : 'Collapsed — click to open'})`}
          onClick={onToggleBibtex}
          type="button"
          aria-pressed={isBibtexOpen}
          aria-label="Toggle BibTeX panel"
        >
          {isBibtexOpen && <span className="right-sidebar-active-bar" />}
          <IconRef size={17} />
          <span className="right-sidebar-tooltip" aria-hidden="true">
            BibTeX
            <small>{isBibtexOpen ? 'Open' : 'Collapsed'}</small>
          </span>
        </button>
      </div>
    </aside>
  );
});

RightSidebar.displayName = 'RightSidebar';
