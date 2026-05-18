const ACTIVITY_MULTIPLIERS = {
  sedentary:   1.2,
  light:       1.375,
  moderate:    1.55,
  active:      1.725,
  very_active: 1.9,
};

// Percentage-based goal modifiers (Mifflin-St Jeor TDEE × modifier)
const GOAL_MULTIPLIERS = {
  lose:     0.80,  // −20% deficit
  maintain: 1.00,
  gain:     1.20,  // +20% surplus
};

// Macro split ratios (protein/fat/carbs as fraction of total calories)
const MACRO_SPLITS = {
  balanced:     { protein: 0.30, fat: 0.30, carbs: 0.40 },
  high_protein: { protein: 0.40, fat: 0.30, carbs: 0.30 },
  low_carb:     { protein: 0.40, fat: 0.40, carbs: 0.20 },
};

// Returns adjusted daily calorie target (integer kcal)
function calculateTDEE(gender, age, heightCm, weightKg, activityLevel, goal) {
  const bmr = gender === 'male'
    ? 10 * weightKg + 6.25 * heightCm - 5 * age + 5
    : 10 * weightKg + 6.25 * heightCm - 5 * age - 161;

  return Math.round(bmr * ACTIVITY_MULTIPLIERS[activityLevel] * GOAL_MULTIPLIERS[goal]);
}

// Returns grams of protein / fat / carbs for a given calorie target and split key
function calculateMacros(calories, split) {
  const s = MACRO_SPLITS[split] || MACRO_SPLITS.balanced;
  return {
    dailyProteinG: Math.round((calories * s.protein) / 4),
    dailyFatG:     Math.round((calories * s.fat)     / 9),
    dailyCarbsG:   Math.round((calories * s.carbs)   / 4),
  };
}

module.exports = { calculateTDEE, calculateMacros };
