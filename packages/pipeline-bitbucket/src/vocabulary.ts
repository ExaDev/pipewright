export const PROVIDER = "bitbucket-pipelines";
export const FILE = "bitbucket-pipelines.yml";

/** The documented range of `max-time`, in minutes. */
export const MAX_TIME_RANGE = { min: 1, max: 720 } as const;

/**
 * Bitbucket documents `runs-on` as available only for self-hosted runners, and a self-hosted runner always carries this label. Any other label set names no Bitbucket runner, so the job runs on Bitbucket's own infrastructure and the labels are not written.
 */
export const SELF_HOSTED_LABEL = "self.hosted";

/** The key under `custom` a manual trigger is published as. */
export const MANUAL_PIPELINE = "manual";
