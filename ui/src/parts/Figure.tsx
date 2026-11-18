/** A row of a result panel: its label and its figure ("Items", "24"). Back up's 22c and Test a backup's 23b have the same rows. */
export function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="fld">
      <div className="fv">
        <span className="fl">{label}</span>
        <span className="fval">{value}</span>
      </div>
    </div>
  );
}
