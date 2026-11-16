import { useEffect, useState } from 'react';
import { formatTimestampTag, type ClockFormat, type DateFormat } from './naming';

/**
 * Provides a live-ticking OCI timestamp tag that pauses automatically as soon as
 * the user manually edits the tag input or while an upload/sync is running.
 */
export function useLiveTimestampTag(opts: {
  isOpen: boolean;
  isBusy: boolean;
  clockFormat: ClockFormat;
  dateFormat: DateFormat;
  resetKey: string;
}) {
  const { isOpen, isBusy, clockFormat, dateFormat, resetKey } = opts;
  const [tagInput, setTagInput] = useState<string>(() =>
    formatTimestampTag(new Date(), clockFormat, dateFormat)
  );
  const [isManuallyEdited, setIsManuallyEdited] = useState<boolean>(false);

  useEffect(() => {
    if (!isOpen) return;
    setIsManuallyEdited(false);
    setTagInput(formatTimestampTag(new Date(), clockFormat, dateFormat));
  }, [isOpen, resetKey, clockFormat, dateFormat]);

  useEffect(() => {
    if (!isOpen || isManuallyEdited || isBusy) return;
    setTagInput(formatTimestampTag(new Date(), clockFormat, dateFormat));
    const timer = setInterval(() => {
      setTagInput(formatTimestampTag(new Date(), clockFormat, dateFormat));
    }, 1000);
    return () => clearInterval(timer);
  }, [isOpen, isManuallyEdited, isBusy, clockFormat, dateFormat]);

  const setCustomTag = (val: string) => {
    setIsManuallyEdited(true);
    setTagInput(val);
  };

  const resumeLiveClock = () => {
    setIsManuallyEdited(false);
    setTagInput(formatTimestampTag(new Date(), clockFormat, dateFormat));
  };

  return { tagInput, isManuallyEdited, setCustomTag, resumeLiveClock };
}
