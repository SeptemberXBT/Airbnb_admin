export const INTERNAL_API_TEST_VECTOR = {
  secret: "noirhaus-test-secret-2026",
  keyId: "test-key-2026",
  method: "POST",
  pathAndQuery: "/api/internal/v1/availability?room=shade-of-love&guests=2",
  timestamp: "1784637000",
  nonce: "123e4567-e89b-42d3-a456-426614174000",
  rawBody: "{\"publicRoomSlug\":\"shade-of-love\",\"checkin\":\"2026-08-14\",\"checkout\":\"2026-08-16\",\"guests\":2}",
  canonical: "POST\n/api/internal/v1/availability?guests=2&room=shade-of-love\n1784637000\n123e4567-e89b-42d3-a456-426614174000\n2c5b3adfa68ad958a9b87c9a7a9c2ea451a2c0cf4b4f9938fe288d3670a84d75",
  signature: "110cdefb6be1cedc0aa13bfc4fc187b85fb27035df5b6dc5e94fbad8a9c6d989",
} as const;
