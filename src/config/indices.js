// Default index derivatives. Lot sizes exchange time-to-time revise karta hai -
// latest NSE/BSE circular se verify karke /api/instruments se update kar lena.
module.exports = [
  { symbol: 'NIFTY', name: 'Nifty 50', type: 'INDEX', exchange: 'NSE', lotSize: 65, strikeStep: 50 },
  { symbol: 'BANKNIFTY', name: 'Nifty Bank', type: 'INDEX', exchange: 'NSE', lotSize: 30, strikeStep: 100 },
  { symbol: 'FINNIFTY', name: 'Nifty Financial Services', type: 'INDEX', exchange: 'NSE', lotSize: 60, strikeStep: 50 },
  { symbol: 'MIDCPNIFTY', name: 'Nifty Midcap Select', type: 'INDEX', exchange: 'NSE', lotSize: 120, strikeStep: 25 },
  { symbol: 'NIFTYNXT50', name: 'Nifty Next 50', type: 'INDEX', exchange: 'NSE', lotSize: 25, strikeStep: 100 },
  { symbol: 'SENSEX', name: 'BSE Sensex', type: 'INDEX', exchange: 'BSE', lotSize: 20, strikeStep: 100 },
  { symbol: 'BANKEX', name: 'BSE Bankex', type: 'INDEX', exchange: 'BSE', lotSize: 30, strikeStep: 100 },
];
