export function ordinalSuffix(wholeNumber: number) {
  const lastTwoDigits = wholeNumber % 100;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 13) return "th";
  switch (wholeNumber % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}
