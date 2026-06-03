/** raw response payload from an HTTP source request */
export interface ResponseDto {
  payload: string;
  // HTTP status of the response. Optional because synthetic responses (tests,
  // non-HTTP sources) may not carry one.
  status?: number;
}
