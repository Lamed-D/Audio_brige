import type { DescriptionSegment } from '../../shared/contracts/manifest';
import type {
  SchedulerEvent,
  SchedulerLastEvent,
  SchedulerManifest,
  SchedulerSnapshot,
  SchedulerSkipReason,
} from './types';

export class DescriptionScheduler {
  private manifest: SchedulerManifest | null = null;
  private readonly handledSegmentIds = new Set<string>();
  private nextIndex = 0;
  private playing = false;
  private lastEvent: SchedulerLastEvent | null = null;

  load(manifest: SchedulerManifest, currentTimeMs: number): void {
    this.manifest = manifest;
    this.handledSegmentIds.clear();
    this.lastEvent = null;
    this.playing = false;

    const firstCurrentIndex = this.findFirstTriggerAtOrAfter(currentTimeMs);
    for (let index = 0; index < firstCurrentIndex; index += 1) {
      this.handledSegmentIds.add(manifest.segments[index].id);
    }
    this.nextIndex = firstCurrentIndex;
  }

  unload(): void {
    this.manifest = null;
    this.handledSegmentIds.clear();
    this.nextIndex = 0;
    this.playing = false;
    this.lastEvent = null;
  }

  setPlaying(playing: boolean): void {
    this.playing = playing;
  }

  tick(currentTimeMs: number): SchedulerEvent[] {
    if (!this.manifest || !this.playing) {
      return [];
    }

    const events: SchedulerEvent[] = [];
    while (this.nextIndex < this.manifest.segments.length) {
      const segment = this.manifest.segments[this.nextIndex];
      if (segment.trigger_ms > currentTimeMs) {
        break;
      }

      if (this.handledSegmentIds.has(segment.id)) {
        this.nextIndex += 1;
        continue;
      }

      const event =
        currentTimeMs <= segment.trigger_ms + this.manifest.playback.late_tolerance_ms
          ? this.createTrigger(segment, currentTimeMs)
          : this.createSkip(segment, currentTimeMs, 'late');
      events.push(event);
      this.markHandled(event);
    }
    return events;
  }

  seek(currentTimeMs: number): SchedulerEvent[] {
    if (!this.manifest) {
      return [];
    }

    const events: SchedulerEvent[] = [];
    for (const segment of this.manifest.segments) {
      if (segment.trigger_ms >= currentTimeMs) {
        break;
      }
      if (this.handledSegmentIds.has(segment.id)) {
        continue;
      }

      const event = this.createSkip(segment, currentTimeMs, 'seek');
      events.push(event);
      this.markHandled(event, false);
    }
    this.nextIndex = this.findNextUnhandledIndex();
    return events;
  }

  getSnapshot(): SchedulerSnapshot | null {
    if (!this.manifest) {
      return null;
    }

    const nextSegment = this.manifest.segments[this.findNextUnhandledIndex()] ?? null;
    return {
      manifest_id: this.manifest.manifest_id,
      revision: this.manifest.revision,
      total_segments: this.manifest.segments.length,
      handled_segments: this.handledSegmentIds.size,
      next_segment_id: nextSegment?.id ?? null,
      next_trigger_ms: nextSegment?.trigger_ms ?? null,
      last_event: this.lastEvent,
    };
  }

  private findFirstTriggerAtOrAfter(currentTimeMs: number): number {
    const segments = this.manifest?.segments ?? [];
    let low = 0;
    let high = segments.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (segments[middle].trigger_ms < currentTimeMs) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  private findNextUnhandledIndex(): number {
    if (!this.manifest) {
      return 0;
    }
    const index = this.manifest.segments.findIndex(
      (segment) => !this.handledSegmentIds.has(segment.id),
    );
    return index === -1 ? this.manifest.segments.length : index;
  }

  private createTrigger(segment: DescriptionSegment, atMs: number): SchedulerEvent {
    return { type: 'trigger', segment, atMs };
  }

  private createSkip(
    segment: DescriptionSegment,
    atMs: number,
    reason: SchedulerSkipReason,
  ): SchedulerEvent {
    return { type: 'skip', segment, atMs, reason };
  }

  private markHandled(event: SchedulerEvent, advanceIndex = true): void {
    this.handledSegmentIds.add(event.segment.id);
    this.lastEvent = {
      type: event.type,
      segment_id: event.segment.id,
      mode: event.segment.mode,
      at_ms: event.atMs,
      ...(event.type === 'skip' ? { reason: event.reason } : {}),
    };
    if (advanceIndex) {
      this.nextIndex += 1;
    }
  }
}
