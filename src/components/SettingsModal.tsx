import React, { useEffect, useState } from 'react';
import { Settings, X, Clock, Calendar } from 'lucide-react';
import type { AppSettings } from './Header';
import {
  formatTimestampTag,
  type ClockFormat,
  type DateFormat,
} from '../lib/naming';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
  isDarkMode: boolean;
  setIsDarkMode: (val: boolean) => void;
}

const DATE_FORMAT_OPTIONS: Array<{ value: DateFormat; label: string; sample: string }> = [
  { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD', sample: '2026-11-16' },
  { value: 'YY-MM-DD', label: 'YY-MM-DD', sample: '26-11-16' },
  { value: 'DD-MM-YYYY', label: 'DD-MM-YYYY', sample: '16-11-2026' },
  { value: 'DD-MM-YY', label: 'DD-MM-YY', sample: '16-11-26' },
];

const CLOCK_FORMAT_OPTIONS: Array<{ value: ClockFormat; label: string; sample: string }> = [
  { value: '24h', label: '24-Hour', sample: '13.05.09' },
  { value: '12h', label: '12-Hour (AM/PM)', sample: '01.05.09pm' },
];

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  setSettings,
  isDarkMode,
  setIsDarkMode,
}) => {
  const [previewNow, setPreviewNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    setPreviewNow(new Date());
    const timer = setInterval(() => setPreviewNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-[#161b22] border border-[#30363d] w-full max-w-2xl rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-6 border-b border-[#30363d] bg-[#0d1117]">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Settings className="w-6 h-6 text-gray-400" /> Application Settings
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="modal-close-btn p-2"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-8 flex-1">
          {/* Appearance Section (5 Themes + Clock & Date Format) */}
          <section>
            <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-4 border-b border-[#30363d] pb-2">
              Appearance
            </h3>
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between bg-[#0d1117] p-4 rounded-md border border-[#30363d]">
                <div>
                  <p className="font-medium text-gray-200">Application Theme</p>
                  <p className="text-xs text-gray-500">
                    Toggle between dark and light themes.
                  </p>
                </div>
                <div
                  className="flex items-center gap-3 select-none cursor-pointer"
                  onClick={() => setIsDarkMode(!isDarkMode)}
                >
                  <span
                    className={`text-sm font-bold ${
                      isDarkMode ? 'theme-active-toggle' : 'text-gray-500'
                    }`}
                  >
                    Dark
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={!isDarkMode}
                    aria-label="Toggle dark and light theme"
                    className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors border theme-toggle-track cursor-pointer"
                  >
                    <span
                      className={`theme-toggle-knob inline-block h-4 w-4 transform rounded-full transition-transform ${
                        !isDarkMode ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                  <span
                    className={`text-sm font-bold ${
                      !isDarkMode ? 'theme-active-toggle' : 'text-gray-500'
                    }`}
                  >
                    Light
                  </span>
                </div>
              </div>

              {/* Color Scheme Variant (5 Themes) */}
              <div className="bg-[#0d1117] p-4 rounded-md border border-[#30363d] animate-in fade-in">
                <p className="font-medium text-gray-200 mb-3 text-sm">
                  Color Scheme Variant
                </p>
                {isDarkMode ? (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setSettings((prev) => ({ ...prev, darkTheme: 'default' }))
                      }
                      className={`p-2.5 text-xs rounded border font-medium transition-colors cursor-pointer ${
                        settings.darkTheme === 'default'
                          ? 'active-variant'
                          : 'border-[#30363d] text-gray-400 hover:border-gray-500'
                      }`}
                    >
                      Default Dark
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setSettings((prev) => ({ ...prev, darkTheme: 'green' }))
                      }
                      className={`p-2.5 text-xs rounded border font-medium transition-colors cursor-pointer ${
                        settings.darkTheme === 'green'
                          ? 'active-variant'
                          : 'border-[#30363d] text-gray-400 hover:border-gray-500'
                      }`}
                    >
                      Green on Black
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setSettings((prev) => ({ ...prev, darkTheme: 'red' }))
                      }
                      className={`p-2.5 text-xs rounded border font-medium transition-colors cursor-pointer ${
                        settings.darkTheme === 'red'
                          ? 'active-variant'
                          : 'border-[#30363d] text-gray-400 hover:border-gray-500'
                      }`}
                    >
                      Red on Black
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setSettings((prev) => ({ ...prev, lightTheme: 'default' }))
                      }
                      className={`p-2.5 text-xs rounded border font-medium transition-colors cursor-pointer ${
                        settings.lightTheme === 'default'
                          ? 'active-variant'
                          : 'border-[#30363d] text-gray-400 hover:border-gray-500'
                      }`}
                    >
                      Default Light
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setSettings((prev) => ({ ...prev, lightTheme: 'monochrome' }))
                      }
                      className={`p-2.5 text-xs rounded border font-medium transition-colors cursor-pointer ${
                        settings.lightTheme === 'monochrome'
                          ? 'active-variant'
                          : 'border-[#30363d] text-gray-400 hover:border-gray-500'
                      }`}
                    >
                      Black on White (Monochrome)
                    </button>
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Timestamp Tags Section (Clock & Date Formats) */}
          <section>
            <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-4 border-b border-[#30363d] pb-2">
              Default Timestamp Tags
            </h3>
            <div className="flex flex-col gap-4">
              <div className="bg-[#0d1117] p-4 rounded-md border border-[#30363d]">
                <div className="flex items-center gap-2 mb-1">
                  <Clock className="w-4 h-4 text-gray-400" />
                  <p className="font-medium text-gray-200 text-sm">Clock Format</p>
                </div>
                <p className="text-xs text-gray-500 mb-3">
                  Time format used for new timestamp tags. Changing this does not alter existing tags on GitHub.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {CLOCK_FORMAT_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() =>
                        setSettings((prev) => ({ ...prev, clockFormat: opt.value }))
                      }
                      className={`p-2.5 text-xs rounded border font-medium transition-colors cursor-pointer flex items-center justify-between gap-2 ${
                        settings.clockFormat === opt.value
                          ? 'active-variant'
                          : 'border-[#30363d] text-gray-400 hover:border-gray-500'
                      }`}
                    >
                      <span>{opt.label}</span>
                      <code className="font-mono text-[11px] opacity-80">{opt.sample}</code>
                    </button>
                  ))}
                </div>
              </div>

              <div className="bg-[#0d1117] p-4 rounded-md border border-[#30363d]">
                <div className="flex items-center gap-2 mb-1">
                  <Calendar className="w-4 h-4 text-gray-400" />
                  <p className="font-medium text-gray-200 text-sm">Date Format</p>
                </div>
                <p className="text-xs text-gray-500 mb-3">
                  Date layout used when generating default upload tags.
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {DATE_FORMAT_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() =>
                        setSettings((prev) => ({ ...prev, dateFormat: opt.value }))
                      }
                      className={`p-2.5 text-xs rounded border font-medium transition-colors cursor-pointer flex flex-col items-center gap-1 ${
                        settings.dateFormat === opt.value
                          ? 'active-variant'
                          : 'border-[#30363d] text-gray-400 hover:border-gray-500'
                      }`}
                    >
                      <span className="font-mono">{opt.label}</span>
                      <span className="text-[10px] opacity-75 font-mono">{opt.sample}</span>
                    </button>
                  ))}
                </div>

                <div className="mt-3 pt-3 border-t border-[#30363d] flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-gray-400">Live default tag preview:</span>
                  <code className="px-2 py-0.5 rounded bg-[#161b22] border border-[#30363d] text-white font-mono font-semibold">
                    {formatTimestampTag(
                      previewNow,
                      settings.clockFormat,
                      settings.dateFormat
                    )}
                  </code>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
