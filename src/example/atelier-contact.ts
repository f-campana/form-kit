import { choiceField, defineContactForm, emailField, phoneField, textField } from "../kit";

/** The four services, plus "Autre", as the quote form lists them. */
export const PROJECT_TYPES = [
  "Meubles sur mesure",
  "Cuisines et rangements",
  "Escaliers et aménagements",
  "Restauration de meubles",
  "Autre",
] as const;

export const TIMELINES = [
  "Dès que possible",
  "Dans les 3 mois",
  "Dans 6 mois ou plus",
  "Je ne sais pas encore",
] as const;

export const BUDGETS = [
  "Moins de 2 000 €",
  "2 000 à 5 000 €",
  "5 000 à 10 000 €",
  "10 000 à 20 000 €",
  "Plus de 20 000 €",
  "Je ne sais pas encore",
] as const;

/**
 * The cabinetmaker pilot's contact form, from pilot-spec.md §3. The name and
 * addresses are placeholders until the business details are chosen. In the
 * pilot site this file belongs to the site's repository, not to the kit.
 */
export const atelierContact = defineContactForm({
  siteName: "Atelier (nom à choisir)",
  from: "formulaire@example.test",
  confirmationReplyTo: "atelier@example.test",
  // The copy promises no reply time ("Ne pas inventer de délai"), so neither does this.
  nextSteps: "Nous reviendrons vers vous pour échanger.",
  recipients: {
    fondateur: ["fondateur@example.test"],
    atelier: ["atelier@example.test"],
  },
  commonFields: {
    name: textField("Nom", { max: 100, required: "Indiquez votre nom." }),
    email: emailField("Adresse e-mail", {
      required: "Indiquez votre adresse e-mail.",
      invalid: "Cette adresse e-mail n’est pas valide.",
    }),
    phone: phoneField("Téléphone", { invalid: "Ce numéro de téléphone n’est pas valide." }),
  },
  reasons: {
    devis: {
      label: "Demande de devis",
      to: "fondateur",
      fields: {
        projectType: choiceField("Type de projet", PROJECT_TYPES, {
          required: "Choisissez le type de projet.",
          invalid: "Choisissez un type de projet dans la liste.",
        }),
        commune: textField("Commune", { max: 100, required: "Indiquez la commune du projet." }),
        description: textField("Description", {
          max: 2000,
          required: "Décrivez votre projet.",
          multiline: true,
        }),
        dimensions: textField("Dimensions approximatives", { max: 200 }),
        timeline: choiceField("Calendrier souhaité", TIMELINES, {
          required: "Choisissez un calendrier.",
          invalid: "Choisissez un calendrier dans la liste.",
        }),
        budget: choiceField("Budget indicatif", BUDGETS, {
          invalid: "Choisissez un budget dans la liste.",
        }),
      },
    },
    visite: {
      label: "Visite de l’atelier",
      to: "fondateur",
      fields: {
        availability: textField("Disponibilités", {
          max: 300,
          required: "Indiquez vos disponibilités.",
          multiline: true,
        }),
      },
    },
    suivi: {
      label: "Suivi d’un projet",
      to: "atelier",
      fields: {
        project: textField("Projet concerné", { max: 200, required: "Indiquez le projet concerné." }),
        followUp: textField("Message", { max: 2000, required: "Écrivez votre message.", multiline: true }),
      },
    },
    autre: {
      label: "Autre question",
      to: "atelier",
      fields: {
        message: textField("Message", { max: 2000, required: "Écrivez votre message.", multiline: true }),
      },
    },
  },
});
