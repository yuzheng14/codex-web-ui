/** A delayed HTTP read cannot replace a newer runtime event or a later requested read. */
export class SystemSnapshotGuard {
  private runtimeRevision = 0;
  private requestSequence = 0;

  beginRead() {
    return { runtimeRevision: this.runtimeRevision, requestSequence: ++this.requestSequence };
  }

  runtimeEvent() {
    this.runtimeRevision++;
  }

  canApplyRead(read: { runtimeRevision: number; requestSequence: number }) {
    return (
      read.runtimeRevision === this.runtimeRevision && read.requestSequence === this.requestSequence
    );
  }
}
