export type BusPayload = Record<string, unknown>;

export type BusRequestType = 'yunzai.status.get' | 'yunzai.action';
export type BusResponseType = 'yunzai.status.result' | 'yunzai.action.result';
export type BusEventType = 'host.status';

export interface BusEnvelope<TPayload extends BusPayload = BusPayload> {
  id: string;
  type: BusRequestType | BusResponseType | BusEventType;
  source: 'web' | 'host';
  target: 'web' | 'host';
  createdAt: number;
  replyTo?: string;
  ok?: boolean;
  payload: TPayload;
  error?: {
    code: string;
    message: string;
  };
}
