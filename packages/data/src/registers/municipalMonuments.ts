/**
 * Municipal monuments (gemeentelijke monumenten), per municipality. There is no national open
 * dataset for these, so each register is compiled from the municipality's own publications and
 * kept here as versioned data, with its source per entry and the date it was last checked.
 *
 * Woensdrecht: the 2018 cultural-history map (appendix III) lists two; two more were designated
 * after the 2023 heritage vision.
 */
export interface MunicipalMonument {
  name: string;
  street: string;
  houseNumber: number;
  city: string;
  source: string;
}

export interface MunicipalRegister {
  checkedOn: string;
  items: MunicipalMonument[];
}

export const MUNICIPAL_MONUMENTS: Record<string, MunicipalRegister> = {
  Woensdrecht: {
    checkedOn: "2026-11-25",
    items: [
      {
        name: "St. Gertrudiskerk",
        street: "Dorpsstraat",
        houseNumber: 1,
        city: "Ossendrecht",
        source:
          "https://repository.officiele-overheidspublicaties.nl/externebijlagen/exb-2018-59634/currentitem",
      },
      {
        name: "Volksabdij Onze Lieve Vrouwe ter Duinen",
        street: "Onze Lieve Vrouwe ter Duinenlaan",
        houseNumber: 199,
        city: "Ossendrecht",
        source:
          "https://repository.officiele-overheidspublicaties.nl/externebijlagen/exb-2018-59634/currentitem",
      },
      {
        name: "Voormalige kloosterkapel (raadzaal)",
        street: "Huijbergseweg",
        houseNumber: 3,
        city: "Hoogerheide",
        source:
          "https://www.woensdrecht.nl/gemeente-wijst-eigen-raadzaal-aan-als-gemeentelijke-monument",
      },
      {
        name: "Poortgebouw Wilhelmietenklooster",
        street: "Staartsestraat",
        houseNumber: 2,
        city: "Huijbergen",
        source: "https://regioonline.nl/regio-roosendaal/poortgebouw-wilhelmietenklooster/",
      },
    ],
  },
};
