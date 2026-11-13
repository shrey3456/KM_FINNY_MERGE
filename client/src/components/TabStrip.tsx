import React from 'react';
import { Plus, X } from 'lucide-react';
import { type AppTab, MAX_TABS, tabIcon, tabIconFill, tabTitle } from '@/lib/appTabs';

interface TabStripProps {
  tabs: AppTab[];
  /** Extra text a page put on its tab (useTabSubtitle), shown after the page name. */
  subtitles: Record<string, string>;
  activeId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}

// Desktop-only Chrome-style tab bar (Layout renders it inside a `hidden lg:flex` bar). Each tab
// shows its page's sidebar icon and name; middle-click closes a tab, like a browser.
const TabStrip: React.FC<TabStripProps> = ({ tabs, subtitles, activeId, onActivate, onClose, onNew }) => (
  <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto pr-2 pt-2 [scrollbar-width:none]">
    {tabs.map((tab) => {
      const active = tab.id === activeId;
      const subtitle = subtitles[tab.id];
      const title = subtitle ? `${tabTitle(tab.path)} · ${subtitle}` : tabTitle(tab.path);
      const Icon = tabIcon(tab.path);
      return (
        <div
          key={tab.id}
          role="tab"
          aria-selected={active}
          title={title}
          onClick={() => onActivate(tab.id)}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              onClose(tab.id);
            }
          }}
          className={`group flex h-9 max-w-xs min-w-[7rem] shrink cursor-pointer select-none items-center gap-2 rounded-t-lg border border-b-0 px-3 text-sm transition-colors ${
            active
              ? 'border-[#001d6e] bg-[#001d6e] font-semibold text-white'
              : 'border-transparent bg-[#001d6e]/10 text-[#001d6e] hover:bg-[#001d6e]/20'
          }`}
        >
          <Icon
            className={`h-4 w-4 shrink-0 ${active ? 'text-white' : 'text-[#001d6e]'}`}
            style={tabIconFill(tab.path) ? { fill: tabIconFill(tab.path) } : undefined}
          />
          <span className="flex-1 truncate whitespace-nowrap">
            {tabTitle(tab.path)}
            {subtitle && <span className={`font-normal ${active ? 'text-white/80' : 'text-[#001d6e]/70'}`}> · {subtitle}</span>}
          </span>
          <button
            type="button"
            aria-label={`Close ${title}`}
            onClick={(e) => {
              e.stopPropagation();
              onClose(tab.id);
            }}
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${active ? 'hover:bg-white/20' : 'hover:bg-[#001d6e]/20'} ${
              active ? '' : 'opacity-0 group-hover:opacity-100'
            }`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      );
    })}
    <button
      type="button"
      onClick={onNew}
      disabled={tabs.length >= MAX_TABS}
      title={tabs.length >= MAX_TABS ? `Up to ${MAX_TABS} tabs` : 'New tab'}
      aria-label="New tab"
      className="mb-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-gray-600 hover:bg-gray-200 disabled:opacity-40"
    >
      <Plus className="h-4 w-4" />
    </button>
  </div>
);

export default TabStrip;
