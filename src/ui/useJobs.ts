import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { UI_PORT, type UiMessage, type UiPush } from '@/src/shared/messages';
import { request } from '@/src/shared/messaging';
import type { Job } from '@/src/shared/types';

/** Live job list, plus a counter that changes whenever a tab's media changes. */
export function useJobs(portSuffix = '') {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [tabChange, setTabChange] = useState({ tabId: -1, count: 0 });

  useEffect(() => {
    const port = browser.runtime.connect({ name: UI_PORT + portSuffix });
    port.onMessage.addListener((raw) => {
      const push = raw as UiPush;
      if (push.type === 'job') {
        setJobs((current) => {
          const others = current.filter((job) => job.id !== push.job.id);
          return [...others, push.job].sort((a, b) => a.createdAt - b.createdAt);
        });
      } else if (push.type === 'job:removed') {
        setJobs((current) => current.filter((job) => job.id !== push.jobId));
      } else {
        setTabChange((current) => ({ tabId: push.tabId, count: current.count + 1 }));
      }
    });
    void request<Job[]>({ type: 'jobs:list' } satisfies UiMessage).then(setJobs);
    return () => port.disconnect();
  }, []);

  return { jobs, tabChange };
}

export const sendJob = (type: 'job:pause' | 'job:resume' | 'job:cancel' | 'job:retry', jobId: string) =>
  request({ type, jobId } satisfies UiMessage);
