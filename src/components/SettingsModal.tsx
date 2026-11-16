import React, { useEffect } from 'react';
import { Settings, X } from 'lucide-react';
import type { AppSettings } from './Header';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
  isDarkMode: boolean;
  setIsDarkMode: (val: boolean) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  setSettings,
  isDarkMode,
  setIsDarkMode,
}) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

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
          {/* Appearance Section (5 Themes + Clock Format) */}
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
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
