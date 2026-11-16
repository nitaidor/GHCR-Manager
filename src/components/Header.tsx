import React, { useRef, useEffect } from 'react';
import {
  Settings,
  HelpCircle,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Info,
  LogOut,
} from 'lucide-react';
import type { GitHubUser } from '../lib/github-oci';

export interface AppSettings {
  darkTheme: 'default' | 'green' | 'red';
  lightTheme: 'default' | 'monochrome';
}

interface HeaderProps {
  isDarkMode: boolean;
  settings: AppSettings;
  user: GitHubUser | null;
  authLoading: boolean;
  showMenu: boolean;
  setShowMenu: (val: boolean) => void;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
  onOpenAbout: () => void;
  onSignOut: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  isDarkMode,
  settings,
  user,
  authLoading,
  showMenu,
  setShowMenu,
  onOpenSettings,
  onOpenHelp,
  onOpenAbout,
  onSignOut,
}) => {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [setShowMenu]);

  const isDefaultTheme = isDarkMode
    ? settings.darkTheme !== 'green' && settings.darkTheme !== 'red'
    : settings.lightTheme !== 'monochrome';

  const renderBadge = () => {
    if (authLoading) {
      return (
        <span className="px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider rounded border flex items-center gap-1.5 status-badge-checking shadow-sm leading-none w-fit mb-[2px]">
          <Loader2 className="w-3 h-3 animate-spin" /> Authenticating...
        </span>
      );
    }
    if (!user) {
      return (
        <span className="px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider rounded border flex items-center gap-1.5 status-badge-warning shadow-sm leading-none w-fit mb-[2px]">
          <AlertTriangle className="w-3 h-3" /> Not Signed In
        </span>
      );
    }
    return (
      <span className="px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider rounded border flex items-center gap-1.5 status-badge-valid shadow-sm leading-none w-fit mb-[2px]">
        <CheckCircle2 className="w-3 h-3" /> {user.login} (ghcr.io)
      </span>
    );
  };

  return (
    <header className="w-full max-w-4xl mb-6 flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[#30363d] pb-6 relative z-50">
      <div className="flex items-center gap-4">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 256 256"
          className={`w-10 h-10 shrink-0 ${!isDefaultTheme ? 'header-logo' : ''}`}
          fill="none"
          aria-hidden="true"
        >
          <rect
            x="32"
            y="32"
            width="192"
            height="192"
            rx="22"
            fill={isDefaultTheme ? 'black' : 'none'}
            stroke={isDefaultTheme ? '#3b82f6' : 'currentColor'}
            strokeWidth="16"
          />
          <path
            d="M 128 68 L 184 100 L 184 156 L 128 188 L 72 156 L 72 100 Z M 72 100 L 128 132 L 184 100 M 128 132 L 128 188 M 100 84 L 156 116"
            stroke={isDefaultTheme ? '#3b82f6' : 'currentColor'}
            strokeWidth="14"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>

        <div>
          <div className="flex items-end gap-3 flex-wrap">
            <h1
              className={`text-3xl font-bold tracking-tight leading-none ${
                !isDarkMode ? 'text-gray-900' : 'text-white'
              }`}
            >
              GHCR Manager
            </h1>

            {renderBadge()}
          </div>
          <p className="text-sm text-gray-400 mt-1.5">
            Build, sync, inspect, download, and manage OCI container packages on ghcr.io.
          </p>
        </div>
      </div>

      <div
        className="absolute right-0 top-0 md:static settings-menu-container relative z-50 flex items-center gap-2"
        ref={menuRef}
      >
        {user && (
          <button
            type="button"
            onClick={onSignOut}
            title="Sign Out"
            className="btn-modal-action px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign Out
          </button>
        )}

        <button
          type="button"
          onClick={() => setShowMenu(!showMenu)}
          aria-label="Settings and options"
          className="header-settings-btn p-2 rounded-md transition-colors"
        >
          <Settings className="w-5 h-5" />
        </button>

        {showMenu && (
          <div className="absolute right-0 top-full mt-2 w-56 border border-[#30363d] bg-[#161b22] rounded-md shadow-2xl z-[100] overflow-hidden animate-in fade-in zoom-in-95 duration-100">
            <button
              type="button"
              onClick={() => {
                onOpenSettings();
                setShowMenu(false);
              }}
              className="theme-menu-item w-full text-left px-4 py-3 text-sm flex items-center gap-2 whitespace-nowrap transition-colors"
            >
              <Settings className="w-4 h-4 shrink-0" /> App Settings
            </button>
            <button
              type="button"
              onClick={() => {
                onOpenHelp();
                setShowMenu(false);
              }}
              className="theme-menu-item w-full text-left px-4 py-3 text-sm flex items-center gap-2 border-t border-[#30363d] whitespace-nowrap transition-colors"
            >
              <HelpCircle className="w-4 h-4 shrink-0" /> Help & Guide
            </button>
            <button
              type="button"
              onClick={() => {
                onOpenAbout();
                setShowMenu(false);
              }}
              className="theme-menu-item w-full text-left px-4 py-3 text-sm flex items-center gap-2 border-t border-[#30363d] whitespace-nowrap transition-colors"
            >
              <Info className="w-4 h-4 shrink-0" /> About GHCR Manager
            </button>
          </div>
        )}
      </div>
    </header>
  );
};

export default Header;
