export default function handler(req, res) {
  res.status(200).json({
    status: 'online',
    service: 'Alphalert Trading Simulator',
    version: '1.0.0',
    endpoints: [
      'POST /api/new-signal',
      'GET /api/check-positions',
      'GET /api/stats',
      'POST /api/reset'
    ]
  });
}
