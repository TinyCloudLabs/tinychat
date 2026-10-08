let enabled = false;

export function serverDeliveryActive(): boolean { return enabled; }
export function setServerDeliveryActive(active: boolean): void { enabled = active; }
